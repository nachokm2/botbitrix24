import { callBitrix, callCrm } from '../bitrix/client';
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
  await callCrm(
    'crm.timeline.comment.add',
    { fields: { ENTITY_ID: entity.id, ENTITY_TYPE: entity.type, COMMENT: comment } },
    auth,
  );
}

/** Carga los últimos registros de conversación IA del CRM como "memoria" entre sesiones. */
export async function loadPriorContext(entity: CrmEntity, auth: Auth): Promise<string> {
  try {
    const r: any = await callCrm(
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
  await callCrm('crm.timeline.comment.add', { fields: { ENTITY_ID: id, ENTITY_TYPE: type, COMMENT: nota } }, auth);
}

/**
 * Fusiona un valor (teléfono/email) en un multicampo de Bitrix SIN borrar los existentes:
 * conserva las entradas actuales (con su ID) y agrega la nueva solo si no está ya presente.
 * Así se actualiza el dato del cliente sin perder, p. ej., el número de WhatsApp.
 */
function mergeMultifield(existing: any, value: string, type: string): any[] {
  const arr: any[] = Array.isArray(existing)
    ? existing.map((e) => ({ ID: e.ID, VALUE: e.VALUE, VALUE_TYPE: e.VALUE_TYPE ?? type }))
    : [];
  const norm = (s: string) => String(s ?? '').replace(/[\s()\-.]/g, '').toLowerCase();
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
      let cur: any = {};
      try {
        cur = (await callCrm('crm.contact.get', { id: e.contact }, auth)) ?? {};
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
      let cur: any = {};
      try {
        cur = (await callCrm('crm.lead.get', { id: e.lead }, auth)) ?? {};
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
  const readPhone = (r: any): string | null => {
    const arr = r?.PHONE;
    if (Array.isArray(arr) && arr.length) {
      const v = String(arr[0]?.VALUE ?? '').trim();
      return v || null;
    }
    return null;
  };
  try {
    if (entities.contact) {
      const c = await callCrm('crm.contact.get', { id: entities.contact }, auth);
      const p = readPhone(c);
      if (p) return p;
    }
    if (entities.lead) {
      const l = await callCrm('crm.lead.get', { id: entities.lead }, auth);
      const p = readPhone(l);
      if (p) return p;
    }
  } catch (e) {
    log.warn('getTelefonoCliente falló', { err: String(e) });
  }
  return null;
}

/**
 * Busca una entidad CRM por número de teléfono usando el webhook admin (crm.duplicate.findbycomm),
 * SIN depender del scope `telephony`. Prioridad: Contacto (con su negociación abierta) → Lead.
 * Se usa en el agente de VOZ para vincular la llamada a un cliente ya existente antes de actualizar.
 */
export async function buscarCrmPorTelefono(phone: string, auth: Auth): Promise<CrmEntities | null> {
  const clean = String(phone || '').trim();
  if (!clean) return null;
  try {
    // 1) ¿Hay un CONTACTO con ese teléfono?
    const c: any = await callCrm('crm.duplicate.findbycomm', { type: 'PHONE', entity_type: 'CONTACT', values: [clean] }, auth);
    const contactId = Array.isArray(c?.CONTACT) && c.CONTACT.length ? Number(c.CONTACT[0]) : 0;
    if (contactId) {
      const out: CrmEntities = { contact: contactId };
      // Traemos su negociación abierta más reciente para guardar ahí el "programa de interés".
      try {
        const deals: any = await callCrm(
          'crm.deal.list',
          { filter: { CONTACT_ID: contactId, CLOSED: 'N' }, select: ['ID'], order: { ID: 'DESC' } },
          auth,
        );
        const dealId = Array.isArray(deals) && deals.length ? Number(deals[0].ID) : 0;
        if (dealId) out.deal = dealId;
      } catch (e) {
        log.warn('buscarCrmPorTelefono: deal.list falló', { err: String(e) });
      }
      return out;
    }
    // 2) ¿Hay un LEAD con ese teléfono?
    const l: any = await callCrm('crm.duplicate.findbycomm', { type: 'PHONE', entity_type: 'LEAD', values: [clean] }, auth);
    const leadId = Array.isArray(l?.LEAD) && l.LEAD.length ? Number(l.LEAD[0]) : 0;
    if (leadId) return { lead: leadId };
    return null;
  } catch (e) {
    log.warn('buscarCrmPorTelefono falló', { err: String(e) });
    return null;
  }
}

/**
 * Crea un LEAD nuevo con los datos capturados en la llamada (cuando el teléfono no existía en el CRM).
 * Usa el teléfono de la llamada si el cliente no dictó otro. Deja también una nota con lo capturado.
 */
export async function crearLeadDesdeVoz(
  phone: string | undefined,
  data: DatosCliente,
  auth: Auth,
): Promise<CrmEntities | null> {
  const fields: any = {
    TITLE: data.programa_interes
      ? `Interés: ${data.programa_interes}${data.nombre ? ' – ' + data.nombre : ''}`
      : `Llamada IA${data.nombre ? ' – ' + data.nombre : ''}`,
    SOURCE_ID: 'CALL',
    OPENED: 'Y',
  };
  if (data.nombre) fields.NAME = data.nombre;
  if (data.apellido) fields.LAST_NAME = data.apellido;
  if (data.email) fields.EMAIL = [{ VALUE: String(data.email), VALUE_TYPE: 'WORK' }];
  const tel = data.telefono || phone;
  if (tel) fields.PHONE = [{ VALUE: String(tel), VALUE_TYPE: 'MOBILE' }];
  // Nota: el UF de "programa de interés" (BITRIX_UF_PROGRAMA) vive en la Negociación (Deal), no en el Lead;
  // en un lead el programa queda en el TITLE. Se escribe en el Deal vía accionInteresVoz cuando existe.
  try {
    const id: any = await callCrm('crm.lead.add', { fields, params: { REGISTER_SONET_EVENT: 'Y' } }, auth);
    const leadId = Number(id);
    if (!leadId) return null;
    await addNota('lead', leadId, data, auth).catch((e) => log.warn('crearLeadDesdeVoz: nota falló', { err: String(e) }));
    log.info('crearLeadDesdeVoz: lead creado', { leadId });
    return { lead: leadId };
  } catch (e) {
    log.warn('crearLeadDesdeVoz falló', { err: String(e) });
    return null;
  }
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

export type Responsable = { id: number; nombre: string; email?: string; activo?: boolean };

export type DealInfo = {
  categoryId: number | null;
  /** Responsable de la negociación (ASSIGNED_BY_ID): el asesor "dueño" del deal. */
  responsableId: number | null;
  /** Observadores (OBSERVER_IDS): otros asesores que también ven el deal. */
  observerIds: number[];
  titulo?: string;
  stageId?: string;
};

const toIdArray = (raw: any): number[] =>
  (Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === '' ? [] : String(raw).split(','))
    .map((x: any) => Number(x))
    .filter((n: number) => Number.isFinite(n) && n > 0);

/**
 * Lee un deal y devuelve embudo + responsable (ASSIGNED_BY_ID) + observadores (OBSERVER_IDS)
 * en una sola llamada `crm.deal.get`. Bitrix24 asigna el responsable según sus reglas de
 * distribución; los observadores suelen ser el "segundo asesor" que también ve el programa.
 */
export async function getDealInfo(dealId: number, auth: Auth): Promise<DealInfo> {
  try {
    const r: any = await callCrm('crm.deal.get', { id: dealId }, auth);
    const cat = r?.CATEGORY_ID ?? r?.categoryId;
    const asg = r?.ASSIGNED_BY_ID ?? r?.assignedById;
    return {
      categoryId: cat !== undefined && cat !== null ? Number(cat) : null,
      responsableId: asg ? Number(asg) : null,
      observerIds: toIdArray(r?.OBSERVER_IDS ?? r?.observerIds),
      titulo: r?.TITLE,
      stageId: r?.STAGE_ID,
    };
  } catch (e) {
    log.warn('getDealInfo falló', { err: String(e) });
    return { categoryId: null, responsableId: null, observerIds: [] };
  }
}

/** Devuelve el CATEGORY_ID (embudo) de un deal, para elegir la etapa correcta del mapa. */
export async function getDealCategory(dealId: number, auth: Auth): Promise<number | null> {
  return (await getDealInfo(dealId, auth)).categoryId;
}

/**
 * Resuelve nombre/email de uno o varios usuarios de Bitrix (asesores).
 * Requiere que el webhook entrante tenga el scope `user` (Usuarios); si no, devuelve solo el id.
 */
export async function getUsuarios(ids: number[], auth: Auth): Promise<Responsable[]> {
  const uniq = Array.from(new Set(ids.filter((n) => Number.isFinite(n) && n > 0)));
  const out: Responsable[] = [];
  for (const id of uniq) {
    try {
      const r: any = await callCrm('user.get', { ID: id }, auth);
      const u = Array.isArray(r) ? r[0] : (r?.result?.[0] ?? r?.[0] ?? r);
      if (u && (u.NAME || u.LAST_NAME || u.EMAIL)) {
        const nombre = [u.NAME, u.LAST_NAME].filter(Boolean).join(' ').trim() || String(u.EMAIL) || `Usuario ${id}`;
        const email = Array.isArray(u.EMAIL) ? u.EMAIL?.[0]?.VALUE : u.EMAIL;
        out.push({ id, nombre, email, activo: u.ACTIVE !== false });
      } else {
        out.push({ id, nombre: `Usuario ${id}` });
      }
    } catch (e) {
      log.warn('getUsuarios: user.get falló (¿falta scope user en el webhook?)', { id, err: String(e) });
      out.push({ id, nombre: `Usuario ${id}` });
    }
  }
  return out;
}

/** Etapa destino para "interesado" según el embudo: VOICE_STAGE_MAP → VOICE_STAGE_INTERESADO → stageMap[cat].alto. */
function resolveVoiceStage(categoryId: number | null): string {
  const cat = String(categoryId ?? 0);
  return config.voiceStageMap[cat] || config.voiceStageInteresado || config.stageMap[cat]?.alto || '';
}

export type AccionInteresResult = { asesorId?: number; tareaId?: number; etapa?: string };

/**
 * Acciones de "lead caliente" cuando el agente de voz capta interés en un programa. Sobre la
 * NEGOCIACIÓN (Deal) del contacto:
 *   1) escribe el programa en el UF (BITRIX_UF_PROGRAMA),
 *   2) mueve el Deal a la etapa de "interesado" (resolveVoiceStage),
 *   3) crea una TAREA al asesor responsable con plazo (VOICE_TASK_MINUTES, default 15 min).
 * Si solo hay lead/contacto (sin Deal), crea la tarea al asesor de respaldo (VOICE_TASK_FALLBACK_USER)
 * y omite UF/etapa (esos campos viven en el Deal). Best-effort: cada paso falla de forma aislada.
 */
export async function accionInteresVoz(ref: CrmEntities, data: DatosCliente, auth: Auth): Promise<AccionInteresResult> {
  const out: AccionInteresResult = {};
  const dealId = ref.deal;
  let asesorId = config.voiceTaskUserId || 0;
  let categoryId: number | null = null;

  if (dealId) {
    const info = await getDealInfo(dealId, auth);
    if (info.responsableId) asesorId = info.responsableId;
    categoryId = info.categoryId;

    // 1) Programa de interés en el UF del Deal.
    if (config.ufPrograma && data.programa_interes) {
      try {
        await callCrm('crm.deal.update', { id: dealId, fields: { [config.ufPrograma]: data.programa_interes } }, auth);
      } catch (e) {
        log.warn('accionInteresVoz: UF programa falló', { err: String(e) });
      }
    }

    // 2) Mover de etapa.
    const stage = resolveVoiceStage(categoryId);
    if (stage) {
      try {
        await moverEtapaDeal(dealId, stage, auth);
        out.etapa = stage;
      } catch (e) {
        log.warn('accionInteresVoz: mover etapa falló', { err: String(e) });
      }
    }
  }

  // 3) Tarea al asesor con plazo. Vinculada al Deal (o al lead/contacto si no hay Deal).
  if (asesorId) {
    const mins = config.voiceTaskMinutes || 15;
    const deadline = new Date(Date.now() + mins * 60_000).toISOString();
    const nombre = [data.nombre, data.apellido].filter(Boolean).join(' ').trim() || 'el prospecto';
    const prog = data.programa_interes ? ` – ${data.programa_interes}` : '';
    const link = dealId ? `D_${dealId}` : ref.contact ? `C_${ref.contact}` : ref.lead ? `L_${ref.lead}` : '';
    try {
      const t: any = await callCrm(
        'tasks.task.add',
        {
          fields: {
            TITLE: `☎️ Llamar en ${mins} min: ${nombre}${prog}`,
            DESCRIPTION:
              `Lead caliente detectado por el agente de voz (IA).\n` +
              `Programa de interés: ${data.programa_interes ?? '—'}\n` +
              `Teléfono: ${data.telefono ?? '—'} · Correo: ${data.email ?? '—'}\n` +
              `Contactar dentro de ${mins} minutos.`,
            RESPONSIBLE_ID: asesorId,
            DEADLINE: deadline,
            PRIORITY: 2, // alta
            ...(link ? { UF_CRM_TASK: [link] } : {}),
          },
        },
        auth,
      );
      const taskId = Number(t?.task?.id ?? t?.id);
      if (taskId) out.tareaId = taskId;
      out.asesorId = asesorId;
    } catch (e) {
      log.warn('accionInteresVoz: crear tarea falló', { err: String(e) });
    }
  } else {
    log.warn('accionInteresVoz: sin asesor (deal sin responsable y sin VOICE_TASK_FALLBACK_USER); no se crea tarea');
  }

  return out;
}

/** Responsable + observadores de un deal, ya con nombre/email resueltos. */
export async function getDealAsesores(
  dealId: number,
  auth: Auth,
): Promise<{ responsable: Responsable | null; observadores: Responsable[]; info: DealInfo }> {
  const info = await getDealInfo(dealId, auth);
  const ids = [info.responsableId, ...info.observerIds].filter((x): x is number => !!x);
  const usuarios = await getUsuarios(ids, auth);
  const byId = new Map(usuarios.map((u) => [u.id, u]));
  return {
    responsable: info.responsableId ? (byId.get(info.responsableId) ?? { id: info.responsableId, nombre: `Usuario ${info.responsableId}` }) : null,
    observadores: info.observerIds.map((oid) => byId.get(oid) ?? { id: oid, nombre: `Usuario ${oid}` }),
    info,
  };
}
