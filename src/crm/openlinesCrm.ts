import { callBitrix } from '../bitrix/client';
import { log } from '../log';
import type { Auth } from '../store';

// Integración CRM real para el bot de Open Lines.
// Fuente de verdad: el evento ONIMBOTMESSAGEADD trae la vinculación en CHAT_ENTITY_DATA_2
// (ej. "LEAD|1209|COMPANY|0|CONTACT|0|DEAL|0"); fallback: imopenlines.dialog.get.

export type CrmEntity = { type: 'lead' | 'deal' | 'contact' | 'company'; id: number };

const ETID: Record<string, number> = { lead: 1, deal: 2, contact: 3, company: 4 };
// Prioridad de relevancia comercial cuando hay varias entidades vinculadas.
const PRIORITY: CrmEntity['type'][] = ['deal', 'contact', 'lead', 'company'];

/** Parsea "LEAD|1209|COMPANY|0|CONTACT|0|DEAL|0" → la entidad más relevante con id > 0. */
export function parseEntityData2(data2?: string): CrmEntity | null {
  if (!data2 || typeof data2 !== 'string') return null;
  const parts = data2.split('|');
  const found: Partial<Record<CrmEntity['type'], number>> = {};
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const t = (parts[i] || '').toLowerCase();
    const id = Number(parts[i + 1]);
    if (id > 0 && ETID[t]) found[t as CrmEntity['type']] = id;
  }
  for (const t of PRIORITY) if (found[t]) return { type: t, id: found[t]! };
  return null;
}

/** Resuelve la entidad CRM del chat: primero del evento, luego dialog.get. */
export async function resolveCrmEntity(params: any, chatId: any, auth: Auth): Promise<CrmEntity | null> {
  const fromEvent = parseEntityData2(params?.CHAT_ENTITY_DATA_2);
  if (fromEvent) return fromEvent;
  if (!chatId) return null;
  try {
    const r: any = await callBitrix('imopenlines.dialog.get', { CHAT_ID: chatId }, auth);
    return parseEntityData2(r?.entity_data_2);
  } catch (e) {
    log.warn('resolveCrmEntity: dialog.get falló', { err: String(e) });
    return null;
  }
}

/** Crea un lead vinculado a la sesión actual (lo que verá el operador) y lo devuelve. */
export async function ensureLeadForChat(chatId: any, auth: Auth): Promise<CrmEntity | null> {
  try {
    await callBitrix('imopenlines.crm.lead.create', { CHAT_ID: chatId }, auth);
    const r: any = await callBitrix('imopenlines.dialog.get', { CHAT_ID: chatId }, auth);
    return parseEntityData2(r?.entity_data_2);
  } catch (e) {
    log.error('ensureLeadForChat falló', { err: String(e) });
    return null;
  }
}

/** Registra un turno de la conversación en el timeline de la entidad. */
export async function logConversationTurn(entity: CrmEntity, userText: string, botText: string, auth: Auth) {
  const comment = `🤖 Conversación IA\n👤 Cliente: ${userText}\n🤖 Agente: ${botText}`;
  await callBitrix(
    'crm.timeline.comment.add',
    { fields: { ENTITY_ID: entity.id, ENTITY_TYPE: entity.type, COMMENT: comment } },
    auth,
  );
}

/** Carga los últimos registros de conversación IA del CRM como "memoria" entre sesiones. */
export async function loadPriorContext(entity: CrmEntity, auth: Auth): Promise<string> {
  try {
    const r: any = await callBitrix(
      'crm.timeline.comment.list',
      {
        filter: { ENTITY_ID: entity.id, ENTITY_TYPE: entity.type },
        order: { CREATED: 'DESC' },
        select: ['ID', 'CREATED', 'COMMENT'],
      },
      auth,
    );
    const arr: any[] = Array.isArray(r) ? r : (r?.comments ?? []);
    return arr
      .filter((c) => typeof c.COMMENT === 'string' && c.COMMENT.includes('Conversación IA'))
      .slice(0, 6)
      .reverse()
      .map((c) => c.COMMENT)
      .join('\n---\n');
  } catch (e) {
    log.warn('loadPriorContext falló', { err: String(e) });
    return '';
  }
}

/** Registra el interés del cliente: vincula/crea la entidad, deja nota y actualiza datos básicos. */
export async function registrarInteres(
  entity: CrmEntity | null,
  chatId: any,
  data: { programa_interes?: string; nombre?: string; email?: string; telefono?: string; comentario?: string },
  auth: Auth,
): Promise<{ ok: boolean; entity?: CrmEntity; error?: string }> {
  let e = entity;
  if (!e) e = await ensureLeadForChat(chatId, auth);
  if (!e) return { ok: false, error: 'No se pudo determinar ni crear la entidad CRM' };

  const nota =
    '📌 Interés registrado por IA\n' +
    [
      data.programa_interes ? `Programa: ${data.programa_interes}` : '',
      data.nombre ? `Nombre: ${data.nombre}` : '',
      data.email ? `Email: ${data.email}` : '',
      data.telefono ? `Teléfono: ${data.telefono}` : '',
      data.comentario ? `Nota: ${data.comentario}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  await callBitrix(
    'crm.timeline.comment.add',
    { fields: { ENTITY_ID: e.id, ENTITY_TYPE: e.type, COMMENT: nota } },
    auth,
  );

  // Actualiza datos básicos en lead/contact (los deals no tienen NAME/EMAIL directos).
  if ((e.type === 'lead' || e.type === 'contact') && (data.nombre || data.email || data.telefono)) {
    const fields: any = {};
    if (data.nombre) fields.NAME = data.nombre;
    if (data.telefono) fields.PHONE = [{ VALUE: String(data.telefono), VALUE_TYPE: 'WORK' }];
    if (data.email) fields.EMAIL = [{ VALUE: String(data.email), VALUE_TYPE: 'WORK' }];
    const method = e.type === 'lead' ? 'crm.lead.update' : 'crm.contact.update';
    try {
      await callBitrix(method, { id: e.id, fields }, auth);
    } catch (err) {
      log.warn('registrarInteres: update entidad falló', { err: String(err) });
    }
  }
  return { ok: true, entity: e };
}
