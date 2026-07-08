import { callBitrix, callCrm } from '../bitrix/client';
import { log } from '../log';
import type { Auth } from '../store';
import { parseEntityData2, parseAllEntities, type CrmEntity, type CrmEntities } from './entities';

// Binding chat ↔ CRM: resolución de la entidad del diálogo y registro/lectura de la conversación
// en el timeline (memoria entre sesiones).

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
