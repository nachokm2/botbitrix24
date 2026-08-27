import { callBitrix, callCrm } from '../bitrix/client';
import { config } from '../config';
import { log } from '../log';
import type { Auth } from '../store';
import type { CrmEntity, CrmEntities } from './entities';
import type { BitrixContact, BitrixLead, BitrixMultifield } from '../bitrix/types';
import { buscarBrochureDrive, detectarTipo, type BrochureEncontrado } from './driveBrochure';
import { agregarProgramaAcumulado, fusionarBrochures, renderCuerpoBrochureEmail } from './brochureEmail';
import { getDealInfo, getUsuarios } from './directory';
import { guardarVinculoChat, obtenerVinculoChat, borrarVinculoChat } from './chat';

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

/**
 * Crea un lead para un chat de Open Lines (WhatsApp) que Bitrix24 no vinculó por su cuenta.
 * Antes usaba `imopenlines.crm.lead.create` (que debería crear Y vincular el lead solo), pero ese
 * método exige que quien llama sea reconocido como "operador" de la cola en ese momento — falla
 * con `ERROR_USER_NOT_OPERATOR` incluso con el webhook admin y con el usuario ya agregado a la
 * cola; probablemente requiere una sesión real de usuario logueado, no disponible vía API/webhook.
 * Por eso el lead se crea directo con `crm.lead.add` (crearLeadDesde, el mismo camino que Web
 * Chat/Instagram/Messenger) y el vínculo chat↔lead se guarda a mano (guardarVinculoChat), en vez
 * de depender de CHAT_ENTITY_DATA_2 (que se queda vacío para siempre en estos casos).
 */
export async function ensureLeadForChat(chatId: any, auth: Auth, data?: DatosCliente): Promise<CrmEntity | null> {
  const leadId = await crearLeadDesde(data ?? {}, auth, {
    sourceId: 'OTHER',
    tituloPrefijo: 'WhatsApp',
    tituloGenerico: 'Consulta WhatsApp',
    label: 'whatsapp',
  });
  if (!leadId) return null;
  const entity: CrmEntity = { type: 'lead', id: leadId };
  await guardarVinculoChat(chatId, { ...entity, programaInteres: data?.programa_interes }).catch((e) =>
    log.warn('guardarVinculoChat falló', { err: String(e) }),
  );
  return entity;
}

/** Fuente de un lead creado por el agente: cómo se etiqueta y titula (ver crearLeadDesde). */
export type LeadFuente = {
  /** Código de SOURCE_ID en Bitrix24. 'OTHER' cuando el canal no es un valor estándar del portal. */
  sourceId: string;
  /** Prefijo del título cuando SÍ hay programa de interés: "{prefijo}: {programa} – {nombre}". */
  tituloPrefijo: string;
  /** Título cuando NO hay programa de interés todavía. */
  tituloGenerico: string;
  /** Etiqueta para logs. */
  label: string;
};

/**
 * Crea un LEAD a partir de los datos capturados por el agente, para un canal que no tiene una
 * entidad CRM previa que Bitrix24 haya vinculado por sí solo (a diferencia de Open Lines, que
 * la crea vía CHAT_ENTITY_DATA_2). Implementación COMPARTIDA por Web Chat, Instagram, Messenger
 * y Voz (ver ALT-Media-6 de la auditoría: antes era casi el mismo código copiado 3 veces).
 * `telefonoFallback` es el teléfono del canal (p. ej. el número que llamó) cuando el cliente no
 * dictó uno propio — solo lo usa Voz.
 */
export async function crearLeadDesde(
  data: DatosCliente,
  auth: Auth,
  fuente: LeadFuente,
  telefonoFallback?: string,
): Promise<number | null> {
  const fields: any = {
    TITLE: data.programa_interes
      ? `${fuente.tituloPrefijo}: ${data.programa_interes}${data.nombre ? ' – ' + data.nombre : ''}`
      : `${fuente.tituloGenerico}${data.nombre ? ' – ' + data.nombre : ''}`,
    SOURCE_ID: fuente.sourceId,
    OPENED: 'Y',
  };
  if (data.nombre) fields.NAME = data.nombre;
  if (data.apellido) fields.LAST_NAME = data.apellido;
  if (data.email) fields.EMAIL = [{ VALUE: String(data.email), VALUE_TYPE: 'WORK' }];
  const tel = data.telefono || telefonoFallback;
  if (tel) fields.PHONE = [{ VALUE: String(tel), VALUE_TYPE: 'MOBILE' }];
  try {
    const id = await callCrm<string | number>('crm.lead.add', { fields, params: { REGISTER_SONET_EVENT: 'Y' } }, auth);
    const leadId = Number(id);
    if (!leadId) return null;
    await addNota('lead', leadId, data, auth).catch((e) => log.warn(`crearLeadDesde(${fuente.label}): nota falló`, { err: String(e) }));
    log.info(`crearLeadDesde(${fuente.label}): lead creado`, { leadId });
    return leadId;
  } catch (e) {
    log.warn(`crearLeadDesde(${fuente.label}) falló`, { err: String(e) });
    return null;
  }
}

/** Crea un LEAD para una conversación del CHAT WEB (no hay Open Lines que lo cree). */
export function crearLeadWeb(data: DatosCliente, auth: Auth): Promise<number | null> {
  return crearLeadDesde(data, auth, { sourceId: 'WEB', tituloPrefijo: 'Web', tituloGenerico: 'Consulta web', label: 'web' });
}

/**
 * Crea un LEAD para un mensaje directo de Instagram/Messenger (M4). SOURCE_ID='OTHER' porque
 * "Instagram"/"Messenger" no son valores estándar del directorio de fuentes de Bitrix24 en todos
 * los portales (evita un error si el portal no los tiene definidos); el canal queda igual
 * identificable en el TÍTULO para el equipo comercial.
 */
export function crearLeadSocial(data: DatosCliente, auth: Auth, canal: 'instagram' | 'messenger'): Promise<number | null> {
  const label = canal === 'instagram' ? 'Instagram' : 'Messenger';
  return crearLeadDesde(data, auth, { sourceId: 'OTHER', tituloPrefijo: label, tituloGenerico: `Consulta ${label}`, label: canal });
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

/** Nombre del contacto para el saludo del correo — usa el recién capturado en este turno si vino,
 *  si no lee el ya guardado en el contacto (puede venir de un turno anterior). */
async function obtenerNombreContacto(contactId: number | undefined, nombreDelTurno: string | undefined, auth: Auth): Promise<string> {
  if (nombreDelTurno) return nombreDelTurno;
  if (!contactId) return 'Estimado/a';
  try {
    const c: any = await callCrm('crm.contact.get', { id: contactId, select: ['NAME'] }, auth);
    return c?.NAME || 'Estimado/a';
  } catch {
    return 'Estimado/a';
  }
}

/** Celular del asesor responsable (ASSIGNED_BY) del deal, para los botones de llamar/WhatsApp. */
async function obtenerTelefonoAsesor(dealId: number, auth: Auth): Promise<string | undefined> {
  try {
    const info = await getDealInfo(dealId, auth);
    if (!info.responsableId) return undefined;
    const [asesor] = await getUsuarios([info.responsableId], auth);
    return asesor?.telefono;
  } catch {
    return undefined;
  }
}

/** Dispara el Proceso de Negocio (bizproc) que manda el correo con el brochure adjunto — lee el
 *  cuerpo/brochure directo de los campos del Deal (ya actualizados por el caller). */
async function dispararEnvioBrochure(dealId: number, auth: Auth): Promise<void> {
  if (!config.bizprocTemplateBrochure) return;
  try {
    await callCrm(
      'bizproc.workflow.start',
      { TEMPLATE_ID: config.bizprocTemplateBrochure, DOCUMENT_ID: ['crm', 'CCrmDocumentDeal', `DEAL_${dealId}`] },
      auth,
    );
  } catch (e) {
    log.warn('dispararEnvioBrochure falló', { err: String(e), dealId });
  }
}

/** Categoría (embudo) codificada en un STAGE_ID de Bitrix ("C3:NEW" → 3); null si no matchea. */
function categoriaDeStage(stageId: string): number | null {
  const m = /^C(\d+):/.exec(stageId);
  return m ? Number(m[1]) : null;
}

/**
 * Si el deal quedó en el embudo EQUIVOCADO para su programa de interés (pasa cuando Bitrix vincula
 * su propio deal por su cuenta: siempre lo deja en un embudo/etapa fijos, sin importar el programa
 * real) lo mueve al embudo y etapa de "Asignación" que corresponden — eso dispara la regla de
 * asignación de asesor por oferta ya configurada en Bitrix24 (fuera de este código). Si el deal YA
 * está en el embudo correcto, no toca la etapa (no pisa el avance que haya hecho un asesor).
 */
/** Solo LEE (no escribe) — devuelve los campos CATEGORY_ID/STAGE_ID a fusionar en el/los `fields`
 *  que el caller ya va a escribir con un único crm.deal.update (evita una llamada de escritura
 *  separada, y que quede "antes" del resto de campos en el registro de llamadas). Objeto vacío si
 *  no aplica o si el deal ya está en el embudo correcto (no pisa el avance que haya hecho un asesor). */
async function camposAsignacionSiCorresponde(dealId: number, programaInteres: string, auth: Auth): Promise<Record<string, unknown>> {
  const tipo = detectarTipo(programaInteres);
  const stageDestino =
    tipo === 'diplomado' ? config.asignacionStageDiplomado : tipo === 'magister' ? config.asignacionStageMagister : '';
  if (!stageDestino) return {};
  const catDestino = categoriaDeStage(stageDestino);
  if (catDestino === null) return {};
  try {
    const cur: any = await callCrm('crm.deal.get', { id: dealId, select: ['CATEGORY_ID'] }, auth);
    if (Number(cur?.CATEGORY_ID) === catDestino) return {};
    log.info('camposAsignacionSiCorresponde: moviendo deal al embudo/etapa de asignación', { dealId, tipo, stageDestino });
    return { CATEGORY_ID: catDestino, STAGE_ID: stageDestino };
  } catch (e) {
    log.warn('camposAsignacionSiCorresponde falló', { err: String(e), dealId });
    return {};
  }
}

/**
 * Si el chat pasó de nuestro vínculo propio (el lead que creó `ensureLeadForChat`) a una entidad
 * DISTINTA que Bitrix terminó vinculando por su cuenta — pasa porque el auto-CRM nativo de Open
 * Lines sí crea contacto+deal, pero de forma asíncrona/con retraso, después de que ya habíamos
 * creado nuestro propio lead — migra a la nueva entidad los datos que ya se habían guardado en el
 * lead viejo (nombre/email/teléfono), para no perderlos. Sin esto, esos datos quedan huérfanos en
 * un lead que el cliente nunca vuelve a ver.
 */
async function migrarSiCambioDeEntidad(chatId: any, entities: CrmEntities, auth: Auth): Promise<void> {
  if (!chatId) return;
  const previa = await obtenerVinculoChat(chatId);
  if (!previa) return;
  // Destino: preferimos el contacto (tiene NAME/EMAIL/PHONE); si no hay, el lead.
  const destino: CrmEntity | null = entities.contact
    ? { type: 'contact', id: entities.contact }
    : entities.lead
      ? { type: 'lead', id: entities.lead }
      : null;
  const cambioDeEntidad = !!destino && !(destino.type === previa.type && destino.id === previa.id);

  try {
    if (cambioDeEntidad && destino) {
      const origen: any = await callCrm(`crm.${previa.type}.get`, { id: previa.id }, auth);
      const cur: any = await callCrm(`crm.${destino.type}.get`, { id: destino.id }, auth);
      const fields: any = {};
      if (origen?.NAME && !cur?.NAME) fields.NAME = origen.NAME;
      if (origen?.LAST_NAME && !cur?.LAST_NAME) fields.LAST_NAME = origen.LAST_NAME;
      if (origen?.EMAIL?.[0]?.VALUE) fields.EMAIL = mergeMultifield(cur?.EMAIL, origen.EMAIL[0].VALUE, 'WORK');
      if (origen?.PHONE?.[0]?.VALUE) fields.PHONE = mergeMultifield(cur?.PHONE, origen.PHONE[0].VALUE, 'MOBILE');
      if (Object.keys(fields).length) {
        await callCrm(`crm.${destino.type}.update`, { id: destino.id, fields }, auth);
        log.info('migrarSiCambioDeEntidad: datos migrados', { chatId, previa, destino, campos: Object.keys(fields) });
      }
    }

    // El programa de interés solo puede vivir en un campo UF del DEAL (los leads no tienen ese UF,
    // Bitrix no lo define a nivel de entidad Lead) — si ya lo teníamos guardado a mano y apareció
    // un deal nuevo sin programa, lo migramos ahí.
    if (config.ufPrograma && previa.programaInteres && entities.deal) {
      const dealActual: any = await callCrm('crm.deal.get', { id: entities.deal, select: [config.ufPrograma] }, auth);
      const fieldsDeal: Record<string, unknown> = {};
      if (!dealActual?.[config.ufPrograma]) fieldsDeal[config.ufPrograma] = previa.programaInteres;
      // El deal que Bitrix vinculó por su cuenta siempre cae en un embudo/etapa fijos — corrige al
      // de "Asignación" que corresponde al programa, para que la regla de asignación por oferta corra.
      Object.assign(fieldsDeal, await camposAsignacionSiCorresponde(entities.deal, previa.programaInteres, auth));
      if (Object.keys(fieldsDeal).length) {
        await callCrm('crm.deal.update', { id: entities.deal, fields: fieldsDeal }, auth);
        log.info('migrarSiCambioDeEntidad: programa/embudo migrados al deal', {
          chatId,
          dealId: entities.deal,
          campos: Object.keys(fieldsDeal),
        });
      }
    }

    if (cambioDeEntidad) await borrarVinculoChat(chatId);
  } catch (e) {
    log.warn('migrarSiCambioDeEntidad falló', { err: String(e), chatId, previa, destino });
  }
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
  await migrarSiCambioDeEntidad(chatId, e, auth);
  if (!e.lead && !e.contact && !e.deal) {
    const creado = await ensureLeadForChat(chatId, auth, data);
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
    let brochureNuevo = false;
    if (data.programa_interes) {
      fields.TITLE = `${data.programa_interes}${data.nombre ? ' – ' + data.nombre : ''}`;
      // Campo personalizado dedicado, para reportería/filtrado: guarda solo el ÚLTIMO programa
      // mencionado (sin cambios respecto al comportamiento anterior).
      if (config.ufPrograma) fields[config.ufPrograma] = data.programa_interes;
      // Embudo/etapa de asignación por oferta (ver camposAsignacionSiCorresponde) — fusionado en
      // el mismo `fields` para que sea UN solo crm.deal.update, no una llamada de escritura aparte.
      Object.assign(fields, await camposAsignacionSiCorresponde(e.deal, data.programa_interes, auth));
      // Brochure(s) del/los programa(s) de interés — se ACUMULAN durante toda la conversación: si
      // la persona menciona un programa nuevo, se manda UN correo con TODOS los brochures juntos,
      // cada uno en su propio archivo (slots UF dedicados; si sobran programas respecto a slots,
      // los que sobran se fusionan en el último slot).
      if (config.ufBrochureFile) {
        const { programas, esNuevo } = await agregarProgramaAcumulado(e.deal, data.programa_interes);
        if (esNuevo) {
          const pares = await Promise.all(
            programas.map(async (p) => ({ programa: p, brochure: await buscarBrochureDrive(p, auth) })),
          );
          const encontrados = pares.filter(
            (x): x is { programa: string; brochure: BrochureEncontrado } => !!x.brochure,
          );
          if (encontrados.length) {
            const slots = [config.ufBrochureFile, config.ufBrochureFile2, config.ufBrochureFile3].filter(Boolean);
            for (let i = 0; i < slots.length && i < encontrados.length; i++) {
              const esUltimoSlot = i === slots.length - 1;
              const grupo = esUltimoSlot ? encontrados.slice(i) : [encontrados[i]];
              const merged = await fusionarBrochures(grupo.map((x) => Buffer.from(x.brochure.contenidoBase64, 'base64')));
              const nombreArchivo = grupo.length > 1 ? 'Brochures.pdf' : grupo[0].brochure.fileName;
              fields[slots[i]] = { fileData: [nombreArchivo, merged.toString('base64')] };
              if (esUltimoSlot) break;
            }
            brochureNuevo = true;

            if (config.ufCuerpoBrochureHtml) {
              const [nombre, telefonoAsesor] = await Promise.all([
                obtenerNombreContacto(e.contact, data.nombre, auth),
                obtenerTelefonoAsesor(e.deal, auth),
              ]);
              fields[config.ufCuerpoBrochureHtml] = renderCuerpoBrochureEmail({
                nombre,
                programas: encontrados.map((x) => x.programa),
                telefonoAsesor,
              });
            }
          }
        }
      }
    }
    if (data.comentario) fields.COMMENTS = data.comentario;
    try {
      if (Object.keys(fields).length) {
        await callCrm('crm.deal.update', { id: e.deal, fields }, auth);
      }
      // Dispara el envío del correo (bizproc) DESPUÉS del update, para que el flujo lea el
      // programa/brochure ya actualizados en el Deal.
      if (brochureNuevo) await dispararEnvioBrochure(e.deal, auth);
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
    if (data.programa_interes) {
      fields.TITLE = `Interés: ${data.programa_interes}${data.nombre ? ' – ' + data.nombre : ''}`;
      // Un lead no tiene el UF de programa (solo existe en Deal) — se guarda en el vínculo propio
      // para poder migrarlo si más tarde Bitrix vincula un deal (ver migrarSiCambioDeEntidad).
      await guardarVinculoChat(chatId, { type: 'lead', id: e.lead, programaInteres: data.programa_interes }).catch(
        (err) => log.warn('guardarVinculoChat (lead) falló', { err: String(err) }),
      );
    }
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

export type ContextoLlamada = { nombre?: string; programa?: string };

/** Datos ya conocidos del cliente (nombre + programa de interés) para que la llamada de voz
 *  abra CON contexto en vez de volver a pedirlos (contacto.NAME + UF programa del deal). */
export async function obtenerContextoLlamada(entities: CrmEntities, auth: Auth): Promise<ContextoLlamada> {
  const ctx: ContextoLlamada = {};
  try {
    if (entities.contact) {
      const c = await callCrm<BitrixContact>('crm.contact.get', { id: entities.contact }, auth);
      const nombre = [c?.NAME, c?.LAST_NAME].filter(Boolean).join(' ').trim();
      if (nombre) ctx.nombre = nombre;
    }
    if (entities.deal && config.ufPrograma) {
      const d = await callCrm<any>('crm.deal.get', { id: entities.deal }, auth);
      const programa = d?.[config.ufPrograma];
      if (programa) ctx.programa = String(programa);
    }
  } catch (e) {
    log.warn('obtenerContextoLlamada falló', { err: String(e) });
  }
  return ctx;
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

/** ¿Hay una captura de datos de contacto EN CURSO (nombre/email/teléfono con algunos ya guardados
 *  pero no todos)? Se usa para no interrumpir con una auto-escalación justo cuando el bot está a
 *  mitad de pedir los datos (score alto + secuencia de captura sin terminar → cortaba antes de
 *  llegar al teléfono). Sin captura empezada (0 de 3) o ya completa (3 de 3), no bloquea nada. */
export async function capturaDeDatosEnCurso(entities: CrmEntities, auth: Auth): Promise<boolean> {
  const leerCompletitud = (r: BitrixContact | BitrixLead) => ({
    nombre: !!r?.NAME,
    email: Array.isArray(r?.EMAIL) && r.EMAIL.length > 0,
    telefono: Array.isArray(r?.PHONE) && r.PHONE.length > 0,
  });
  try {
    let datos: { nombre: boolean; email: boolean; telefono: boolean } | null = null;
    if (entities.contact) {
      datos = leerCompletitud(await callCrm<BitrixContact>('crm.contact.get', { id: entities.contact }, auth));
    } else if (entities.lead) {
      datos = leerCompletitud(await callCrm<BitrixLead>('crm.lead.get', { id: entities.lead }, auth));
    }
    if (!datos) return false;
    const completados = [datos.nombre, datos.email, datos.telefono].filter(Boolean).length;
    return completados > 0 && completados < 3;
  } catch (e) {
    log.warn('capturaDeDatosEnCurso falló', { err: String(e) });
    return false; // ante duda, no bloquear la escalación
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

/**
 * Agrega un comentario de texto libre al timeline de la entidad principal (deal → contact → lead).
 * Lo usan las acciones de la campaña de VOZ SALIENTE (no interesado, objeción, callback, no titular)
 * para dejar registro visible al asesor sin duplicar la lógica de selección de entidad.
 */
export async function comentarTimeline(entities: CrmEntities, texto: string, auth: Auth): Promise<boolean> {
  const primary: CrmEntity | null = entities.deal
    ? { type: 'deal', id: entities.deal }
    : entities.contact
      ? { type: 'contact', id: entities.contact }
      : entities.lead
        ? { type: 'lead', id: entities.lead }
        : null;
  if (!primary) return false;
  try {
    await callCrm(
      'crm.timeline.comment.add',
      { fields: { ENTITY_ID: primary.id, ENTITY_TYPE: primary.type, COMMENT: texto } },
      auth,
    );
    return true;
  } catch (e) {
    log.warn('comentarTimeline falló', { err: String(e) });
    return false;
  }
}
