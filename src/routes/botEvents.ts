import type { Request, Response } from 'express';
import { extractAuth } from '../bitrix/auth';
import { callBitrix } from '../bitrix/client';
import { getState } from '../store';
import { config } from '../config';
import { log } from '../log';

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
  const message: string | undefined = params.MESSAGE;
  const entity: string | undefined =
    params.CHAT_ENTITY_TYPE ?? params?.CHAT?.CHAT_ENTITY_TYPE;
  const fromUserId = params.FROM_USER_ID;

  const auth = extractAuth(req);
  const botId = firstBotId(body?.data?.BOT) ?? (await getState()).botId ?? config.botId;

  // CRITERIO 1 — confirmar recepción (con estructura para diagnóstico)
  log.info('INBOUND bot message', {
    event: body.event,
    dataKeys: body?.data ? Object.keys(body.data) : null,
    dialogId,
    entity,
    fromUserId,
    botId,
    message,
  });

  if (!auth) return log.warn('botMessage: sin auth en el evento');
  if (!dialogId) return log.warn('botMessage: sin DIALOG_ID', { params });
  if (!message) return log.info('botMessage: evento sin texto (ignorado)');
  if (!botId) return log.warn('botMessage: sin BOT_ID — define BITRIX_BOT_ID en Railway (701561)');

  // CRITERIO 2 — responder (eco); ChatApp debe reenviarlo a WhatsApp
  const reply = `🤖 (PoC eco) Recibí: "${message}"  [entity=${entity ?? 'desconocido'}]`;
  await callBitrix('imbot.message.add', { BOT_ID: botId, DIALOG_ID: dialogId, MESSAGE: reply }, auth);
  log.info('REPLY enviado', { dialogId, botId });
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
        MESSAGE: '🤖 (PoC) ¡Hola! Soy el asistente de prueba. Escríbeme algo y te respondo en eco.',
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
