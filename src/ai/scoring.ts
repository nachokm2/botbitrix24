import { anthropic, CLASSIFIER } from './client';
import { getHistory } from './memory';
import { getSession, saveSession } from '../session';
import { guardarEvaluacionCrm, type CrmEntities, type LeadEval } from '../crm/openlinesCrm';
import { inc } from '../obs/metrics';
import { audit } from '../obs/audit';
import { log } from '../log';
import type { Auth } from '../store';

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

/** Evalúa la conversación y guarda el resultado en el CRM (nota solo si cambia ≥10) + sesión + métricas. */
export async function procesarScoring(dialogId: string, crmEntities: CrmEntities, auth: Auth): Promise<void> {
  const history = await getHistory(dialogId);
  const evalData = await evaluarLead(history);
  if (!evalData) return;

  const sess = await getSession(dialogId);
  const cambioSignificativo = sess.lastScore === undefined || Math.abs(sess.lastScore - evalData.score) >= 10;

  await guardarEvaluacionCrm(crmEntities, evalData, auth, { writeNote: cambioSignificativo });

  sess.lastScore = evalData.score;
  sess.intencion = evalData.intencion;
  sess.sentimiento = evalData.sentimiento;
  await saveSession(dialogId, sess);

  inc('scored');
  inc(`intencion:${evalData.intencion}`);
  inc(`sentimiento:${evalData.sentimiento}`);
  if (cambioSignificativo) {
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
