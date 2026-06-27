import type { Request, Response } from 'express';
import { extractAuth } from '../bitrix/auth';
import { callBitrix } from '../bitrix/client';
import { getState } from '../store';
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
  const botId = firstBotId(body?.data?.BOT) ?? (await getState()).botId;

  // CRITERIO 1 — confirmar recepción
  log.info('INBOUND bot message', { dialogId, entity, fromUserId, botId, message });

  if (!auth) return log.warn('botMessage: sin auth en el evento');
  if (!dialogId) return log.warn('botMessage: sin DIALOG_ID');
  if (!message) return; // ignorar eventos sin texto (typing, sistema, etc.)
  if (!botId) return log.warn('botMessage: sin BOT_ID (registra el bot primero)');

  // CRITERIO 2 — responder (eco); ChatApp debe reenviarlo a WhatsApp
  const reply = `🤖 (PoC eco) Recibí: "${message}"  [entity=${entity ?? 'desconocido'}]`;
  await callBitrix('imbot.message.add', { BOT_ID: botId, DIALOG_ID: dialogId, MESSAGE: reply }, auth);
  log.info('REPLY enviado', { dialogId });
}

function firstBotId(bot: any): number | undefined {
  if (!bot || typeof bot !== 'object') return undefined;
  const k = Object.keys(bot)[0];
  return k ? Number(k) : undefined;
}

export function botWelcomeHandler(_req: Request, res: Response) {
  log.info('bot welcome event');
  res.status(200).json({ ok: true });
}

export function botDeleteHandler(_req: Request, res: Response) {
  log.info('bot delete event');
  res.status(200).json({ ok: true });
}
