import type { Request, Response } from 'express';
import { extractAuth } from '../bitrix/auth';
import { callBitrix } from '../bitrix/client';
import { getState } from '../store';
import { config } from '../config';
import { log } from '../log';
import { runAgentTurn } from '../ai/agentLoop';
import { getHistory } from '../ai/memory';
import { resolveCrmEntity, loadPriorContext, logConversationTurn } from '../crm/openlinesCrm';

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

  // Identifica la entidad CRM vinculada al chat (del propio evento; sin llamada extra si viene).
  const crmEntity = await resolveCrmEntity(params, chatId, auth);
  log.info('CRM entity', { entity: crmEntity ? `${crmEntity.type}#${crmEntity.id}` : 'ninguna' });

  // Memoria entre sesiones: al iniciar una conversación nueva, carga notas previas del CRM.
  const esNueva = getHistory(dialogId).length === 0;
  const priorContext = esNueva && crmEntity ? await loadPriorContext(crmEntity, auth) : '';

  // Indicador de "escribiendo..." mientras razona el agente (no crítico).
  await callBitrix('imbot.chat.sendTyping', { BOT_ID: botId, DIALOG_ID: dialogId }, auth).catch(() => {});

  // Agente real: Claude Sonnet 4.6 + tool-calling + memoria + contexto CRM.
  const reply = await runAgentTurn({ auth, dialogId, chatId, botId, crmEntity }, message, priorContext);

  await callBitrix('imbot.message.add', { BOT_ID: botId, DIALOG_ID: dialogId, MESSAGE: reply }, auth);
  log.info('REPLY enviado', { dialogId, botId });

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

export async function botWelcomeHandler(req: Request, res: Response) {
  log.info('POST /events/bot/welcome recibido', { event: (req.body as any)?.event });
  res.status(200).json({ ok: true }); // ACK inmediato
  void (async () => {
    const body: any = req.body ?? {};
    const params = body?.data?.PARAMS ?? {};
    const dialogId: string | undefined = params.DIALOG_ID;
    const auth = extractAuth(req);
    const botId = firstBotId(body?.data?.BOT) ?? (await getState()).botId ?? config.botId;

    log.info('WELCOME', { dialogId, botId, dataKeys: body?.data ? Object.keys(body.data) : null });
    if (!auth || !dialogId || !botId) {
      return log.warn('welcome: faltan datos', { hasAuth: Boolean(auth), dialogId, botId });
    }
    await callBitrix(
      'imbot.message.add',
      {
        BOT_ID: botId,
        DIALOG_ID: dialogId,
        MESSAGE:
          '¡Hola! 👋 Soy el asistente de Postgrados de la Universidad Autónoma de Chile. ' +
          '¿Sobre qué área o programa te gustaría saber?',
      },
      auth,
    );
    log.info('WELCOME reply enviado', { dialogId, botId });
  })().catch((e) => log.error('welcome: error', { err: String(e) }));
}

export function botDeleteHandler(_req: Request, res: Response) {
  log.info('bot delete event');
  res.status(200).json({ ok: true });
}
