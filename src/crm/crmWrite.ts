import { callBitrix, callCrm } from '../bitrix/client';
import { config } from '../config';
import { log } from '../log';
import type { Auth } from '../store';
import { parseEntityData2, type CrmEntity, type CrmEntities } from './entities';
import type { BitrixContact, BitrixLead, BitrixDialog, BitrixMultifield } from '../bitrix/types';

// Escrituras al CRM: creación/actualización de contacto/lead/deal, notas de timeline,
// persistencia del scoring y lectura del teléfono del cliente.

export type LeadEval = { score: number; intencion: string; sentimiento: string; justificacion: string };

export type DatosCliente = {
  nombre?: string;
  apellido?: string;
  email?: string;
  telefono?: string;
  rut?: string;
  programa_interes?: string;
  comentario?: string;
};

/** Crea un lead vinculado a la sesión actual (lo que verá el operador) y lo devuelve. */
export async function ensureLeadForChat(chatId: any, auth: Auth): Promise<CrmEntity | null> {
  try {
    await callBitrix('imopenlines.crm.lead.create', { CHAT_ID: chatId }, auth);
    const r = await callBitrix<BitrixDialog>('imopenlines.dialog.get', { CHAT_ID: chatId }, auth);
    return parseEntityData2(r?.entity_data_2);
  } catch (e) {
    log.error('ensureLeadForChat falló', { err: String(e) });
    return null;
  }
}

/**
 * Crea un LEAD para una conversación del CHAT WEB (no hay Open Lines que lo cree). Deja una nota con
 * lo capturado. Devuelve el id del lead o null. Las siguientes capturas usan actualizarDatosCliente.
 */
export async function crearLeadWeb(data: DatosCliente, auth: Auth): Promise<number | null> {
  const fields: any = {
    TITLE: data.programa_interes
      ? `Web: ${data.programa_interes}${data.nombre ? ' – ' + data.nombre : ''}`
      : `Consulta web${data.nombre ? ' – ' + data.nombre : ''}`,
    SOURCE_ID: 'WEB',
    OPENED: 'Y',
  };
  if (data.nombre) fields.NAME = data.nombre;
  if (data.apellido) fields.LAST_NAME = data.apellido;
  if (data.email) fields.EMAIL = [{ VALUE: String(data.email), VALUE_TYPE: 'WORK' }];
  if (data.telefono) fields.PHONE = [{ VALUE: String(data.telefono), VALUE_TYPE: 'MOBILE' }];
  try {
    const id = await callCrm<string | number>('crm.lead.add', { fields, params: { REGISTER_SONET_EVENT: 'Y' } }, auth);
    const leadId = Number(id);
    if (!leadId) return null;
    await addNota('lead', leadId, data, auth).catch((e) => log.warn('crearLeadWeb: nota falló', { err: String(e) }));
    log.info('crearLeadWeb: lead creado', { leadId });
    return leadId;
  } catch (e) {
    log.warn('crearLeadWeb falló', { err: String(e) });
    return null;
  }
}

/**
 * Crea un LEAD para un mensaje directo de Instagram/Messenger (M4). Mismo patrón que crearLeadWeb:
 * SOURCE_ID='OTHER' porque "Instagram"/"Messenger" no son valores estándar del directorio de
 * fuentes de Bitrix24 en todos los portales (evita un error si el portal no los tiene definidos);
 * el canal queda igual identificable en el TÍTULO para el equipo comercial.
 */
export async function crearLeadSocial(data: DatosCliente, auth: Auth, canal: 'instagram' | 'messenger'): Promise<number | null> {
  const label = canal === 'instagram' ? 'Instagram' : 'Messenger';
  const fields: any = {
    TITLE: data.programa_interes
      ? `${label}: ${data.programa_interes}${data.nombre ? ' – ' + data.nombre : ''}`
      : `Consulta ${label}${data.nombre ? ' – ' + data.nombre : ''}`,
    SOURCE_ID: 'OTHER',
    OPENED: 'Y',
  };
  if (data.nombre) fields.NAME = data.nombre;
  if (data.apellido) fields.LAST_NAME = data.apellido;
  if (data.email) fields.EMAIL = [{ VALUE: String(data.email), VALUE_TYPE: 'WORK' }];
  if (data.telefono) fields.PHONE = [{ VALUE: String(data.telefono), VALUE_TYPE: 'MOBILE' }];
  try {
    const id = await callCrm<string | number>('crm.lead.add', { fields, params: { REGISTER_SONET_EVENT: 'Y' } }, auth);
    const leadId = Number(id);
    if (!leadId) return null;
    await addNota('lead', leadId, data, auth).catch((e) => log.warn('crearLeadSocial: nota falló', { err: String(e) }));
    log.info('crearLeadSocial: lead creado', { leadId, canal });
    return leadId;
  } catch (e) {
    log.warn('crearLeadSocial falló', { err: String(e), canal });
    return null;
  }
}

export async function addNota(type: CrmEntity['type'], id: number, data: DatosCliente, auth: Auth) {
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
  await callCrm('crm.timeline.comment.add', { fields: { ENTITY_ID: id, ENTITY_TYPE: type, COMMENT: nota } }, auth);
}

/**
 * Fusiona un valor (teléfono/email) en un multicampo de Bitrix SIN borrar los existentes:
 * conserva las entradas actuales (con su ID) y agrega la nueva solo si no está ya presente.
 * Así se actualiza el dato del cliente sin perder, p. ej., el número de WhatsApp.
 */
function mergeMultifield(existing: BitrixMultifield[] | undefined, value: string, type: string): BitrixMultifield[] {
  const arr: BitrixMultifield[] = Array.isArray(existing)
    ? existing.map((e) => ({ ID: e.ID, VALUE: e.VALUE, VALUE_TYPE: e.VALUE_TYPE ?? type }))
    : [];
  const norm = (s: string | undefined) => String(s ?? '').replace(/[\s()\-.]/g, '').toLowerCase();
  if (norm(value) && arr.some((e) => norm(e.VALUE) === norm(value))) return arr;
  arr.push({ VALUE: value, VALUE_TYPE: type });
  return arr;
}

/**
 * Toma los datos capturados y actualiza el CONTACTO y el DEAL vinculados al chat
 * (o el lead si esa es la entidad). Email y teléfono se FUSIONAN con los existentes
 * (no se pierde el número de WhatsApp); nombre/apellido se actualizan directo.
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

  // CONTACTO: nombre/apellido + email/teléfono (fusionados con los existentes).
  if (e.contact) {
    const fields: any = {};
    if (data.nombre) fields.NAME = data.nombre;
    if (data.apellido) fields.LAST_NAME = data.apellido;
    if (data.email || data.telefono) {
      let cur: BitrixContact = {};
      try {
        cur = (await callCrm<BitrixContact>('crm.contact.get', { id: e.contact }, auth)) ?? {};
      } catch (err) {
        log.warn('contact.get para fusionar email/teléfono falló', { err: String(err) });
      }
      if (data.email) fields.EMAIL = mergeMultifield(cur.EMAIL, String(data.email), 'WORK');
      if (data.telefono) fields.PHONE = mergeMultifield(cur.PHONE, String(data.telefono), 'MOBILE');
    }
    try {
      if (Object.keys(fields).length) {
        await callCrm('crm.contact.update', { id: e.contact, fields }, auth);
        actualizado.push(`contact#${e.contact}`);
      }
      await addNota('contact', e.contact, data, auth);
    } catch (err) {
      log.warn('actualizar contacto falló', { err: String(err) });
    }
  }

  // DEAL: título + campo UF "Programa de interés" + nota.
  if (e.deal) {
    const fields: any = {};
    if (data.programa_interes) {
      fields.TITLE = `${data.programa_interes}${data.nombre ? ' – ' + data.nombre : ''}`;
      // Campo personalizado dedicado, para reportería/filtrado (se actualiza según la conversación).
      if (config.ufPrograma) fields[config.ufPrograma] = data.programa_interes;
    }
    if (data.comentario) fields.COMMENTS = data.comentario;
    try {
      if (Object.keys(fields).length) {
        await callCrm('crm.deal.update', { id: e.deal, fields }, auth);
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
    if (data.email || data.telefono) {
      let cur: BitrixLead = {};
      try {
        cur = (await callCrm<BitrixLead>('crm.lead.get', { id: e.lead }, auth)) ?? {};
      } catch (err) {
        log.warn('lead.get para fusionar email/teléfono falló', { err: String(err) });
      }
      if (data.email) fields.EMAIL = mergeMultifield(cur.EMAIL, String(data.email), 'WORK');
      if (data.telefono) fields.PHONE = mergeMultifield(cur.PHONE, String(data.telefono), 'MOBILE');
    }
    if (data.programa_interes) fields.TITLE = `Interés: ${data.programa_interes}${data.nombre ? ' – ' + data.nombre : ''}`;
    try {
      if (Object.keys(fields).length) {
        await callCrm('crm.lead.update', { id: e.lead, fields }, auth);
      }
      await addNota('lead', e.lead, data, auth);
      actualizado.push(`lead#${e.lead}`);
    } catch (err) {
      log.warn('actualizar lead falló', { err: String(err) });
    }
  }

  return { ok: actualizado.length > 0, actualizado };
}

/** Devuelve el primer teléfono guardado del cliente (contacto → lead). Para llamarlo por voz. */
export async function getTelefonoCliente(entities: CrmEntities, auth: Auth): Promise<string | null> {
  const readPhone = (r: BitrixContact | BitrixLead): string | null => {
    const arr = r?.PHONE;
    if (Array.isArray(arr) && arr.length) {
      const v = String(arr[0]?.VALUE ?? '').trim();
      return v || null;
    }
    return null;
  };
  try {
    if (entities.contact) {
      const c = await callCrm<BitrixContact>('crm.contact.get', { id: entities.contact }, auth);
      const p = readPhone(c);
      if (p) return p;
    }
    if (entities.lead) {
      const l = await callCrm<BitrixLead>('crm.lead.get', { id: entities.lead }, auth);
      const p = readPhone(l);
      if (p) return p;
    }
  } catch (e) {
    log.warn('getTelefonoCliente falló', { err: String(e) });
  }
  return null;
}

/** Guarda la evaluación del lead (score/intención/sentimiento) en el CRM: campos UF (si están
 *  configurados) en deal/contacto/lead, y opcionalmente una nota en el timeline. */
export async function guardarEvaluacionCrm(
  entities: CrmEntities,
  evalData: LeadEval,
  auth: Auth,
  opts: { writeNote: boolean },
): Promise<void> {
  const primary: CrmEntity | null = entities.deal
    ? { type: 'deal', id: entities.deal }
    : entities.contact
      ? { type: 'contact', id: entities.contact }
      : entities.lead
        ? { type: 'lead', id: entities.lead }
        : null;
  if (!primary) return;

  // Los campos UF de scoring están en el Deal (Negociación) → solo se actualizan ahí.
  if (entities.deal) {
    const ufFields: any = {};
    if (config.ufScore) ufFields[config.ufScore] = evalData.score;
    if (config.ufIntent) ufFields[config.ufIntent] = evalData.intencion;
    if (config.ufSentiment) ufFields[config.ufSentiment] = evalData.sentimiento;
    if (Object.keys(ufFields).length) {
      try {
        await callCrm('crm.deal.update', { id: entities.deal, fields: ufFields }, auth);
      } catch (e) {
        log.warn('guardarEvaluacion: UF update falló', { err: String(e) });
      }
    }
  }

  if (opts.writeNote) {
    const nota =
      `🎯 Evaluación IA — Score ${evalData.score}/100 · Intención: ${evalData.intencion} · ` +
      `Sentimiento: ${evalData.sentimiento}\n${evalData.justificacion}`;
    await callCrm(
      'crm.timeline.comment.add',
      { fields: { ENTITY_ID: primary.id, ENTITY_TYPE: primary.type, COMMENT: nota } },
      auth,
    );
  }
}

/** Mueve el deal a una etapa (STAGE_ID) del embudo. */
export async function moverEtapaDeal(dealId: number, stageId: string, auth: Auth): Promise<void> {
  await callCrm('crm.deal.update', { id: dealId, fields: { STAGE_ID: stageId } }, auth);
}
