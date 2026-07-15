import { anthropic, CLASSIFIER } from './client';
import { getHistory } from './memory';
import { callCrm } from '../bitrix/client';
import { recordTokens, inc } from '../obs/metrics';
import { audit } from '../obs/audit';
import { log } from '../log';
import type { Auth } from '../store';
import type { CrmEntity } from '../crm/entities';

const BRIEFING_SYSTEM = `Preparas un RESUMEN BREVE para un asesor comercial de postgrados de la Universidad Autónoma de Chile que va a retomar la conversación con un lead. A partir de la conversación entrega, en español, viñetas cortas y accionables:
- Programa/área de interés (si se mencionó).
- Datos de contacto entregados (nombre, email, teléfono) o "no entregó".
- Nivel de interés y señales de decisión/urgencia.
- Dudas u objeciones planteadas.
- Próximo paso sugerido para el asesor.
Máximo ~120 palabras. NO inventes datos que no estén en la conversación.`;

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
      const who = m.role === 'assistant' ? 'Bot' : 'Cliente';
      return text.trim() ? `${who}: ${text.trim()}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Genera un resumen del lead (Claude Haiku) y lo deja como nota en la entidad CRM, para el asesor. */
export async function generarBriefing(dialogId: string, entity: CrmEntity, auth: Auth): Promise<void> {
  try {
    const t = transcript(await getHistory(dialogId));
    if (t.length < 5) return;
    const resp = await anthropic.messages.create({
      model: CLASSIFIER,
      max_tokens: 400,
      system: BRIEFING_SYSTEM,
      messages: [{ role: 'user', content: `Conversación:\n${t}\n\nEntrega el resumen para el asesor.` }],
    });
    recordTokens((resp as any).usage);
    const texto = (resp.content as any[]).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    if (!texto) return;
    await callCrm(
      'crm.timeline.comment.add',
      { fields: { ENTITY_ID: entity.id, ENTITY_TYPE: entity.type, COMMENT: `🧑‍💼 Resumen para el asesor (IA)\n${texto}` } },
      auth,
    );
    inc('briefing');
    await audit({ type: 'briefing', dialogId, crmEntity: `${entity.type}#${entity.id}` });
    log.info('briefing generado', { dialogId, entity: `${entity.type}#${entity.id}` });
  } catch (e) {
    log.warn('generarBriefing falló', { err: String(e) });
  }
}
