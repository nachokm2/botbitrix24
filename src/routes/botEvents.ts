import type { Request, Response } from 'express';
import { extractAuth } from '../bitrix/auth';
import { callBitrix } from '../bitrix/client';
import { getState } from '../store';
import { config } from '../config';
import { log } from '../log';
import { runAgentTurn } from '../ai/agentLoop';
import { getHistory } from '../ai/memory';
import { getSession, saveSession } from '../session';
import { once } from '../store/kv';
import { inc } from '../obs/metrics';
import { audit } from '../obs/audit';
import { resolveAllEntities, primaryEntity, loadPriorContext, logConversationTurn } from '../crm/openlinesCrm';

/**
 * Handler de ONIMBOTMESSAGEADD (mensaje del cliente al bot de Open Lines).
 * Responde ACK <1s y procesa en segundo plano (eco).
 *
 * Valida los 3 criterios del PoC (§7.4.6):
 *  1) Recepción del inbound de ChatApp (log "INBOUND ...", entity=LINES)
 *  2) La respuesta llega a WhatsApp (imbot.message.add → ChatApp)
 *  3) Precedencia bot-primero (se observa en el portal/ChatApp)
 */
export async function botMessageHandler(req: Request, res: Response) {
  // Confirma que el endpoint fue invocado (aunque el payload no sea el esperado).
  log.info('POST /events/bot/message recibido', { event: (req.body as any)?.event });
  res.status(200).json({ ok: true }); // ACK inmediato
  void handle(req).catch((e) => log.error('botMessage: error', { err: String(e) }));
}

async function handle(req: Request) {
  const body: any = req.body ?? {};
  const params = body?.data?.PARAMS ?? {};
  const dialogId: string | undefined = params.DIALOG_ID;
  const chatId = params.CHAT_ID;
  const message: string | undefined = params.MESSAGE;
  const entity: string | undefined =
    params.CHAT_ENTITY_TYPE ?? params?.CHAT?.CHAT_ENTITY_TYPE;
  const fromUserId = params.FROM_USER_ID;

  const auth = extractAuth(req);
  const botId = firstBotId(body?.data?.BOT) ?? (await getState()).botId ?? config.botId;

  log.info('INBOUND bot message', { event: body.event, dialogId, chatId, entity, fromUserId, botId, message });

  if (!auth) return log.warn('botMessage: sin auth en el evento');
  if (!dialogId) return log.warn('botMessage: sin DIALOG_ID', { params });
  if (!message) return log.info('botMessage: evento sin texto (ignorado)');
  if (!botId) return log.warn('botMessage: sin BOT_ID — define BITRIX_BOT_ID en Railway (701561)');

  // Idempotencia: descarta eventos duplicados (Bitrix puede reenviar).
  const msgId = params.MESSAGE_ID;
  if (msgId && !(await once(`evt:msg:${msgId}`, 3600))) {
    return log.info('botMessage: evento duplicado ignorado', { msgId });
  }

  // ── El bot solo responde al CLIENTE; si interviene un operador, se calla (humano a cargo) ──
  const fromUser = String(fromUserId ?? '');
  const sess = await getSession(dialogId);
  let sessChanged = false;
  if (!sess.clientId && fromUser) {
    sess.clientId = fromUser; // primer mensaje = cliente
    sessChanged = true;
  }
  if (sess.clientId && fromUser && fromUser !== sess.clientId) {
    sess.humanTookOver = true; // mensaje de un operador u otro usuario
    await saveSession(dialogId, sess);
    inc('operator_msg');
    return log.info('botMessage: mensaje de operador/otro usuario; bot en silencio', {
      fromUser,
      clientId: sess.clientId,
    });
  }
  if (sess.humanTookOver) {
    return log.info('botMessage: sesión atendida por humano; bot en silencio', { dialogId });
  }
  if (sessChanged) await saveSession(dialogId, sess);

  inc('inbound');

  // Identifica las entidades CRM vinculadas al chat (del propio evento; sin llamada extra si viene).
  const crmEntities = await resolveAllEntities(params, chatId, auth);
  const crmEntity = primaryEntity(crmEntities);
  log.info('CRM entity', { primary: crmEntity ? `${crmEntity.type}#${crmEntity.id}` : 'ninguna', all: crmEntities });

  // Memoria entre sesiones: al iniciar una conversación nueva, carga notas previas del CRM.
  const esNueva = (await getHistory(dialogId)).length === 0;
  if (esNueva) inc('conversations');
  const priorContext = esNueva && crmEntity ? await loadPriorContext(crmEntity, auth) : '';

  // Indicador de "escribiendo..." mientras razona el agente (no crítico).
  await callBitrix('imbot.chat.sendTyping', { BOT_ID: botId, DIALOG_ID: dialogId }, auth).catch(() => {});

  // Agente real: Claude Sonnet 4.6 + tool-calling + memoria + contexto CRM.
  const reply = await runAgentTurn({ auth, dialogId, chatId, botId, crmEntity, crmEntities }, message, priorContext);

  await callBitrix('imbot.message.add', { BOT_ID: botId, DIALOG_ID: dialogId, MESSAGE: reply }, auth);
  inc('reply');
  log.info('REPLY enviado', { dialogId, botId });

  // Auditoría del turno (compliance) — independiente del CRM.
  await audit({
    type: 'turn',
    dialogId,
    crmEntity: crmEntity ? `${crmEntity.type}#${crmEntity.id}` : undefined,
    detail: { message, reply },
  });

  // Registra automáticamente la conversación en el timeline del CRM (no bloquea la respuesta).
  if (crmEntity) {
    logConversationTurn(crmEntity, message, reply, auth).catch((e) =>
      log.warn('logConversationTurn falló', { err: String(e) }),
    );
  }
}

function firstBotId(bot: any): number | undefined {
  if (!bot || typeof bot !== 'object') return undefined;
  const k = Object.keys(bot)[0];
  return k ? Number(k) : undefined;
}

export function botWelcomeHandler(req: Request, res: Response) {
  // No enviamos saludo aquí: el agente saluda al responder el primer mensaje del cliente
  // (evita el doble saludo y da un saludo contextual).
  log.info('POST /events/bot/welcome recibido (join, sin saludo fijo)', { event: (req.body as any)?.event });
  res.status(200).json({ ok: true });
}

export function botDeleteHandler(_req: Request, res: Response) {
  log.info('bot delete event');
  res.status(200).json({ ok: true });
}
