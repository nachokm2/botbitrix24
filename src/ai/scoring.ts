import { anthropic, CLASSIFIER } from './client';
import { getHistory } from './memory';
import { getSession, saveSession } from '../session';
import { guardarEvaluacionCrm, moverEtapaDeal, type CrmEntities, type LeadEval } from '../crm/openlinesCrm';
import { callBitrix } from '../bitrix/client';
import { config } from '../config';
import { inc } from '../obs/metrics';
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

  // 1) Mover la etapa del deal según el score (si hay deal y etapas configuradas).
  if (crmEntities.deal) {
    let target = '';
    if (evalData.score >= 70 && config.stageScoreAlto) target = config.stageScoreAlto;
    else if (evalData.score >= 40 && config.stageScoreMedio) target = config.stageScoreMedio;
    if (target && target !== sess.lastStage) {
      try {
        await moverEtapaDeal(crmEntities.deal, target, auth);
        sess.lastStage = target;
        inc('stage_move');
        await audit({
          type: 'stage_move',
          dialogId,
          crmEntity: `deal#${crmEntities.deal}`,
          detail: { stage: target, score: evalData.score },
        });
        log.info('etapa del deal movida por score', { dealId: crmEntities.deal, stage: target, score: evalData.score });
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
      detail: { score: evalData.score, intencion: evalData.intencion, sentimiento: evalData.sentimiento },
    });
  }
  log.info('lead score', {
    dialogId,
    score: evalData.score,
    intencion: evalData.intencion,
    sentimiento: evalData.sentimiento,
  });
}
