import { callBitrix } from '../bitrix/client';
import { config } from '../config';
import { log } from '../log';
import type { Auth } from '../store';

export type LeadEval = { score: number; intencion: string; sentimiento: string; justificacion: string };

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

/** Todas las entidades CRM vinculadas al chat (puede haber deal + contacto a la vez). */
export type CrmEntities = { lead?: number; contact?: number; deal?: number; company?: number };

export function parseAllEntities(data2?: string): CrmEntities {
  const out: CrmEntities = {};
  if (!data2 || typeof data2 !== 'string') return out;
  const parts = data2.split('|');
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const t = (parts[i] || '').toLowerCase() as keyof CrmEntities;
    const id = Number(parts[i + 1]);
    if (id > 0 && (t === 'lead' || t === 'contact' || t === 'deal' || t === 'company')) out[t] = id;
  }
  return out;
}

export function primaryEntity(e: CrmEntities): CrmEntity | null {
  for (const t of PRIORITY) if (e[t]) return { type: t, id: e[t]! };
  return null;
}

/** Resuelve TODAS las entidades del chat (evento; fallback dialog.get). */
export async function resolveAllEntities(params: any, chatId: any, auth: Auth): Promise<CrmEntities> {
  const fromEvent = parseAllEntities(params?.CHAT_ENTITY_DATA_2);
  if (Object.keys(fromEvent).length) return fromEvent;
  if (!chatId) return {};
  try {
    const r: any = await callBitrix('imopenlines.dialog.get', { CHAT_ID: chatId }, auth);
    return parseAllEntities(r?.entity_data_2);
  } catch (e) {
    log.warn('resolveAllEntities: dialog.get falló', { err: String(e) });
    return {};
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

export type DatosCliente = {
  nombre?: string;
  apellido?: string;
  email?: string;
  telefono?: string;
  rut?: string;
  programa_interes?: string;
  comentario?: string;
};

async function addNota(type: CrmEntity['type'], id: number, data: DatosCliente, auth: Auth) {
  const nota =
    '📌 Datos capturados por IA\n' +
    [
      data.programa_interes ? `Programa de interés: ${data.programa_interes}` : '',
      data.nombre ? `Nombre: ${data.nombre}` : '',
      data.apellido ? `Apellido: ${data.apellido}` : '',
      data.email ? `Email: ${data.email}` : '',
      data.telefono ? `Teléfono: ${data.telefono}` : '',
      data.rut ? `RUT: ${data.rut}` : '',
      data.comentario ? `Nota: ${data.comentario}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  await callBitrix('crm.timeline.comment.add', { fields: { ENTITY_ID: id, ENTITY_TYPE: type, COMMENT: nota } }, auth);
}

/**
 * Toma los datos capturados y actualiza el CONTACTO y el DEAL vinculados al chat
 * (o el lead si esa es la entidad). No sobrescribe el teléfono de WhatsApp.
 */
export async function actualizarDatosCliente(
  entities: CrmEntities,
  chatId: any,
  data: DatosCliente,
  auth: Auth,
): Promise<{ ok: boolean; actualizado: string[]; error?: string }> {
  let e = entities;
  if (!e.lead && !e.contact && !e.deal) {
    const creado = await ensureLeadForChat(chatId, auth);
    if (creado) e = { [creado.type]: creado.id };
  }
  if (!e.lead && !e.contact && !e.deal) {
    return { ok: false, actualizado: [], error: 'No se pudo determinar ni crear la entidad CRM' };
  }

  const actualizado: string[] = [];

  // CONTACTO: nombre/apellido/email (no tocamos el teléfono de WhatsApp ya guardado).
  if (e.contact) {
    const fields: any = {};
    if (data.nombre) fields.NAME = data.nombre;
    if (data.apellido) fields.LAST_NAME = data.apellido;
    if (data.email) fields.EMAIL = [{ VALUE: String(data.email), VALUE_TYPE: 'WORK' }];
    try {
      if (Object.keys(fields).length) {
        await callBitrix('crm.contact.update', { id: e.contact, fields }, auth);
        actualizado.push(`contact#${e.contact}`);
      }
      await addNota('contact', e.contact, data, auth);
    } catch (err) {
      log.warn('actualizar contacto falló', { err: String(err) });
    }
  }

  // DEAL: título con el programa de interés + nota.
  if (e.deal) {
    const fields: any = {};
    if (data.programa_interes) {
      fields.TITLE = `${data.programa_interes}${data.nombre ? ' – ' + data.nombre : ''}`;
    }
    if (data.comentario) fields.COMMENTS = data.comentario;
    try {
      if (Object.keys(fields).length) {
        await callBitrix('crm.deal.update', { id: e.deal, fields }, auth);
      }
      await addNota('deal', e.deal, data, auth);
      actualizado.push(`deal#${e.deal}`);
    } catch (err) {
      log.warn('actualizar deal falló', { err: String(err) });
    }
  }

  // LEAD: solo si no hay contacto/deal (modo "lead" del canal).
  if (e.lead && !e.contact && !e.deal) {
    const fields: any = {};
    if (data.nombre) fields.NAME = data.nombre;
    if (data.apellido) fields.LAST_NAME = data.apellido;
    if (data.email) fields.EMAIL = [{ VALUE: String(data.email), VALUE_TYPE: 'WORK' }];
    if (data.programa_interes) fields.TITLE = `Interés: ${data.programa_interes}${data.nombre ? ' – ' + data.nombre : ''}`;
    try {
      if (Object.keys(fields).length) {
        await callBitrix('crm.lead.update', { id: e.lead, fields }, auth);
      }
      await addNota('lead', e.lead, data, auth);
      actualizado.push(`lead#${e.lead}`);
    } catch (err) {
      log.warn('actualizar lead falló', { err: String(err) });
    }
  }

  return { ok: actualizado.length > 0, actualizado };
}

/** Guarda la evaluación del lead (score/intención/sentimiento) en el CRM: campos UF (si están
 *  configurados) en deal/contacto/lead, y opcionalmente una nota en el timeline. */
export async function guardarEvaluacionCrm(
  entities: CrmEntities,
  evalData: LeadEval,
  auth: Auth,
  opts: { writeNote: boolean },
): Promise<void> {
  const targets: CrmEntity[] = [];
  if (entities.deal) targets.push({ type: 'deal', id: entities.deal });
  if (entities.contact) targets.push({ type: 'contact', id: entities.contact });
  if (entities.lead && !entities.deal && !entities.contact) targets.push({ type: 'lead', id: entities.lead });
  if (targets.length === 0) return;

  // Campos personalizados (si la unidad los creó y los configuró por env).
  const ufFields: any = {};
  if (config.ufScore) ufFields[config.ufScore] = evalData.score;
  if (config.ufIntent) ufFields[config.ufIntent] = evalData.intencion;
  if (config.ufSentiment) ufFields[config.ufSentiment] = evalData.sentimiento;

  for (const t of targets) {
    if (Object.keys(ufFields).length) {
      const method =
        t.type === 'deal' ? 'crm.deal.update' : t.type === 'contact' ? 'crm.contact.update' : 'crm.lead.update';
      try {
        await callBitrix(method, { id: t.id, fields: ufFields }, auth);
      } catch (e) {
        log.warn('guardarEvaluacion: UF update falló', { err: String(e) });
      }
    }
  }

  if (opts.writeNote) {
    const t = targets[0];
    const nota =
      `🎯 Evaluación IA — Score ${evalData.score}/100 · Intención: ${evalData.intencion} · ` +
      `Sentimiento: ${evalData.sentimiento}\n${evalData.justificacion}`;
    await callBitrix(
      'crm.timeline.comment.add',
      { fields: { ENTITY_ID: t.id, ENTITY_TYPE: t.type, COMMENT: nota } },
      auth,
    );
  }
}
