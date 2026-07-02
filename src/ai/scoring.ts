import { anthropic, CLASSIFIER } from './client';
import { getHistory } from './memory';
import { getSession, saveSession } from '../session';
import {
  guardarEvaluacionCrm,
  moverEtapaDeal,
  getDealInfo,
  primaryEntity,
  type CrmEntities,
  type LeadEval,
} from '../crm/openlinesCrm';
import { generarBriefing } from './briefing';
import { callBitrix } from '../bitrix/client';
import { config } from '../config';
import { inc, recordTokens } from '../obs/metrics';
import { audit } from '../obs/audit';
import { log } from '../log';
import type { Auth } from '../store';

export type ScoringCtx = {
  dialogId: string;
  chatId?: string | number;
  botId: number;
  crmEntities: CrmEntities;
  auth: Auth;
};

const SCORING_SYSTEM = `Eres un evaluador de leads comerciales para programas de postgrado de la Universidad Autónoma de Chile.
Analiza la conversación y devuelve SOLO un JSON (sin texto adicional, sin markdown) con esta forma exacta:
{"score": <entero 0-100>, "intencion": "alta|media|baja", "sentimiento": "positivo|neutral|negativo", "justificacion": "<1 frase>"}
El "score" estima la calidad/probabilidad de matrícula del lead. Considera: claridad del interés en un programa concreto,
datos de contacto entregados (nombre, email), urgencia/decisión y tono. Sé estricto: sin interés claro, score bajo.`;

function transcript(messages: any[]): string {
  return messages
    .map((m) => {
      const c = m.content;
      const text =
        typeof c === 'string'
          ? c
          : Array.isArray(c)
            ? c.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ')
            : '';
      return text.trim() ? `${m.role}: ${text.trim()}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Clasifica la conversación con Haiku → score + intención + sentimiento. */
export async function evaluarLead(messages: any[]): Promise<LeadEval | null> {
  const t = transcript(messages);
  if (t.length < 5) return null;
  try {
    const resp = await anthropic.messages.create({
      model: CLASSIFIER,
      max_tokens: 200,
      system: SCORING_SYSTEM,
      messages: [{ role: 'user', content: `Conversación:\n${t}\n\nDevuelve el JSON.` }],
    });
    recordTokens((resp as any).usage);
    const raw = (resp.content as any[]).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    return {
      score: Math.max(0, Math.min(100, Math.round(Number(json.score) || 0))),
      intencion: String(json.intencion || 'media'),
      sentimiento: String(json.sentimiento || 'neutral'),
      justificacion: String(json.justificacion || ''),
    };
  } catch (e) {
    log.warn('evaluarLead falló', { err: String(e) });
    return null;
  }
}

/**
 * Evalúa la conversación, guarda el scoring en el CRM, mueve la etapa del deal
 * según el puntaje y auto-escala a un asesor si el score es alto.
 */
export async function procesarScoring(ctx: ScoringCtx): Promise<void> {
  const { dialogId, chatId, botId, crmEntities, auth } = ctx;
  const history = await getHistory(dialogId);
  const evalData = await evaluarLead(history);
  if (!evalData) return;

  const sess = await getSession(dialogId);
  const cambio = sess.lastScore === undefined || Math.abs(sess.lastScore - evalData.score) >= 10;

  await guardarEvaluacionCrm(crmEntities, evalData, auth, { writeNote: cambio });

  sess.lastScore = evalData.score;
  sess.intencion = evalData.intencion;
  sess.sentimiento = evalData.sentimiento;

  // 1) Mover la etapa del deal según el score, usando la etapa del EMBUDO del deal (C1, C3, ...).
  if (crmEntities.deal) {
    // Resuelve embudo (CATEGORY_ID) + responsable (ASSIGNED_BY_ID) del deal en UNA llamada, cacheados.
    if (sess.dealCategory === undefined || sess.responsableId === undefined) {
      const info = await getDealInfo(crmEntities.deal, auth);
      if (sess.dealCategory === undefined) sess.dealCategory = info.categoryId ?? -1;
      if (sess.responsableId === undefined) sess.responsableId = info.responsableId ?? -1;
    }

    let m: { alto?: string; medio?: string } | undefined;
    if (Object.keys(config.stageMap).length) {
      m = config.stageMap[String(sess.dealCategory)];
    } else if (config.stageScoreAlto || config.stageScoreMedio) {
      m = { alto: config.stageScoreAlto, medio: config.stageScoreMedio }; // legacy de un solo embudo
    }

    let target = '';
    if (m) {
      if (evalData.score >= 70 && m.alto) target = m.alto;
      else if (evalData.score >= 40 && m.medio) target = m.medio;
    }
    if (target && target !== sess.lastStage) {
      try {
        await moverEtapaDeal(crmEntities.deal, target, auth);
        sess.lastStage = target;
        inc('stage_move');
        await audit({
          type: 'stage_move',
          dialogId,
          crmEntity: `deal#${crmEntities.deal}`,
          detail: { stage: target, score: evalData.score, categoryId: sess.dealCategory },
        });
        log.info('etapa del deal movida por score', {
          dealId: crmEntities.deal,
          stage: target,
          score: evalData.score,
          categoryId: sess.dealCategory,
        });
      } catch (e) {
        log.warn('moverEtapaDeal falló', { err: String(e) });
      }
    }
  }

  // 2) Auto-escalar a un asesor humano si el score alcanza el umbral.
  if (
    config.scoreEscalar > 0 &&
    evalData.score >= config.scoreEscalar &&
    !sess.escalatedByScore &&
    !sess.humanTookOver &&
    chatId
  ) {
    try {
      await callBitrix(
        'imbot.message.add',
        {
          BOT_ID: botId,
          DIALOG_ID: dialogId,
          MESSAGE: 'Por tu interés, te conecto con un asesor que resolverá tus dudas y te guiará en la postulación. 🙌',
        },
        auth,
      );
      await callBitrix('imopenlines.bot.session.operator', { CHAT_ID: chatId }, auth);
      sess.escalatedByScore = true;
      sess.humanTookOver = true; // el bot deja de responder; atiende el asesor

      // Resumen del lead para el asesor (una sola vez).
      if (!sess.briefingDone) {
        const ent = primaryEntity(crmEntities);
        if (ent) {
          sess.briefingDone = true;
          void generarBriefing(dialogId, ent, auth);
        }
      }

      inc('auto_escalation');
      await audit({
        type: 'auto_escalation',
        dialogId,
        crmEntity: crmEntities.deal ? `deal#${crmEntities.deal}` : undefined,
        detail: { score: evalData.score },
      });
      log.info('auto-escalado por score alto', { dialogId, score: evalData.score });
    } catch (e) {
      log.warn('auto-escalación falló', { err: String(e) });
    }
  }

  await saveSession(dialogId, sess);

  inc('scored');
  inc(`intencion:${evalData.intencion}`);
  inc(`sentimiento:${evalData.sentimiento}`);
  if (cambio) {
    await audit({
      type: 'lead_score',
      dialogId,
      crmEntity: crmEntities.deal ? `deal#${crmEntities.deal}` : undefined,
      detail: {
        score: evalData.score,
        intencion: evalData.intencion,
        sentimiento: evalData.sentimiento,
        categoryId: sess.dealCategory,
        responsableId: sess.responsableId,
      },
    });
  }
  log.info('lead score', {
    dialogId,
    score: evalData.score,
    intencion: evalData.intencion,
    sentimiento: evalData.sentimiento,
  });
}
