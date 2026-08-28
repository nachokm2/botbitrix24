import { callBitrix, callCrm } from '../bitrix/client';
import { config } from '../config';
import { log } from '../log';
import type { Auth } from '../store';
import { getJson, setJson, kvDel } from '../store/kv';
import { parseEntityData2, parseAllEntities, type CrmEntity, type CrmEntities } from './entities';
import type { BitrixDialog, BitrixTimelineComment, BitrixTimelineCommentResponse } from '../bitrix/types';

// Binding chat ↔ CRM: resolución de la entidad del diálogo y registro/lectura de la conversación
// en el timeline (memoria entre sesiones).

const CHAT_LINK_KEY = (chatId: any) => `crm:chatLink:${chatId}`;

/** Vínculo propio chat↔entidad, con el ÚLTIMO programa de interés capturado — un lead no tiene
 *  campo UF de programa (ese UF solo existe en Deal), así que se guarda acá para poder migrarlo
 *  al Deal si Bitrix vincula uno más tarde (ver migrarSiCambioDeEntidad en crmWrite.ts). */
export type VinculoChat = CrmEntity & { programaInteres?: string };

/**
 * Guarda a mano el vínculo chat↔entidad CRM cuando lo creamos nosotros (ver ensureLeadForChat en
 * crmWrite.ts) — reemplaza el vínculo nativo de Bitrix (CHAT_ENTITY_DATA_2), que `imopenlines.crm.
 * lead.create` debería fijar solo pero requiere que quien llama sea reconocido como "operador" de
 * la cola: falla igual con el webhook admin y con el token de la app (ver ERROR_USER_NOT_OPERATOR),
 * probablemente porque ese método exige una sesión real de usuario logueado, no disponible vía API.
 * Sin TTL: el vínculo debe durar tanto como la propia conversación (igual que CHAT_ENTITY_DATA_2).
 */
export async function guardarVinculoChat(chatId: any, vinculo: VinculoChat): Promise<void> {
  await setJson(CHAT_LINK_KEY(chatId), vinculo);
}

/** Lee el vínculo guardado a mano (ver guardarVinculoChat) — fallback cuando Bitrix no vinculó nada. */
export async function obtenerVinculoChat(chatId: any): Promise<VinculoChat | null> {
  return getJson<VinculoChat>(CHAT_LINK_KEY(chatId));
}

/** Borra el vínculo propio — se llama una vez que Bitrix vinculó su propia entidad al chat (ver
 *  migrarSiCambioDeEntidad en crmWrite.ts), para dejar de consultarlo en turnos futuros. */
export async function borrarVinculoChat(chatId: any): Promise<void> {
  await kvDel(CHAT_LINK_KEY(chatId));
}

/** Resuelve la entidad CRM del chat: primero del evento, luego dialog.get. */
export async function resolveCrmEntity(params: any, chatId: any, auth: Auth): Promise<CrmEntity | null> {
  const fromEvent = parseEntityData2(params?.CHAT_ENTITY_DATA_2);
  if (fromEvent) return fromEvent;
  if (!chatId) return null;
  try {
    const r = await callBitrix<BitrixDialog>('imopenlines.dialog.get', { CHAT_ID: chatId }, auth);
    return parseEntityData2(r?.entity_data_2);
  } catch (e) {
    log.warn('resolveCrmEntity: dialog.get falló', { err: String(e) });
    return null;
  }
}

/** Resuelve TODAS las entidades del chat (evento; fallback dialog.get). */
export async function resolveAllEntities(params: any, chatId: any, auth: Auth): Promise<CrmEntities> {
  const fromEvent = parseAllEntities(params?.CHAT_ENTITY_DATA_2);
  if (Object.keys(fromEvent).length) return fromEvent;
  if (!chatId) return {};
  try {
    const r = await callBitrix<BitrixDialog>('imopenlines.dialog.get', { CHAT_ID: chatId }, auth);
    const fromDialog = parseAllEntities(r?.entity_data_2);
    if (Object.keys(fromDialog).length) return fromDialog;
  } catch (e) {
    log.warn('resolveAllEntities: dialog.get falló', { err: String(e) });
  }
  // Bitrix no vinculó nada (ni el evento ni dialog.get) — usa el vínculo que hayamos guardado
  // nosotros mismos (ver ensureLeadForChat/guardarVinculoChat), por si ya creamos un lead antes.
  const propio = await obtenerVinculoChat(chatId);
  return propio ? { [propio.type]: propio.id } : {};
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
  const partes: string[] = [];

  // Programa de interés YA registrado en el Deal (p. ej. un deal creado por una campaña de marketing
  // o un formulario web, ANTES de que el cliente escriba nada por este chat) — sin esto, el bot le
  // vuelve a preguntar "¿qué programa te interesa?" aunque el CRM ya lo traiga (caso real: deal
  // #3491489, Diego Carvajal, llegó desde una campaña con "Diplomado en Inteligencia Artificial" ya
  // en el UF, y el bot igual preguntó desde cero).
  if (entity.type === 'deal' && config.ufPrograma) {
    try {
      const d: any = await callCrm('crm.deal.get', { id: entity.id, select: [config.ufPrograma] }, auth);
      const programa = d?.[config.ufPrograma];
      if (programa) {
        partes.push(
          `Programa de interés YA REGISTRADO en el CRM para este cliente: "${programa}". Puedes usarlo directamente ` +
            `(saludarlo mencionándolo, cotizar, dar detalles) sin volver a preguntarle qué programa le interesa — ` +
            `solo pregúntalo de nuevo si el cliente menciona explícitamente uno distinto.`,
        );
      }
    } catch (e) {
      log.warn('loadPriorContext: no se pudo leer el programa del deal', { err: String(e), dealId: entity.id });
    }
  }

  try {
    const r = await callCrm<BitrixTimelineCommentResponse>(
      'crm.timeline.comment.list',
      {
        filter: { ENTITY_ID: entity.id, ENTITY_TYPE: entity.type },
        order: { CREATED: 'DESC' },
        select: ['ID', 'CREATED', 'COMMENT'],
      },
      auth,
    );
    const arr: BitrixTimelineComment[] = Array.isArray(r) ? r : (r?.comments ?? []);
    const notas = arr
      .filter((c) => typeof c.COMMENT === 'string' && c.COMMENT.includes('Conversación IA'))
      .slice(0, 6)
      .reverse()
      .map((c) => c.COMMENT)
      .join('\n---\n');
    if (notas) partes.push(notas);
  } catch (e) {
    log.warn('loadPriorContext falló', { err: String(e) });
  }

  return partes.join('\n---\n');
}
