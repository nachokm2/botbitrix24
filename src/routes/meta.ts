import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { config } from '../config';
import { log } from '../log';
import { once } from '../store/kv';
import { metaTurn, type MetaChannel } from '../channels/meta';
import { getState, EMPTY_AUTH } from '../store';
import { safeEqual } from '../util/crypto';

// M4 — Rutas de los canales INSTAGRAM y MESSENGER (Meta Graph API / "Messenger Platform").
// Ambos comparten el mismo formato de webhook ("entry[].messaging[]") y la misma Send API; se
// distinguen por el campo "object" del payload ("page" = Messenger, "instagram" = Instagram).
//
// Requiere, en la app de Meta (developers.facebook.com): suscribir el webhook a esta URL con el
// campo "messages" (Messenger) y/o "messages" de Instagram; Page Access Token con los scopes
// pages_messaging + instagram_basic + instagram_manage_messages. Ver META_* en .env.example.

/** GET /webhooks/meta — handshake de verificación que Meta llama una vez, al suscribir el webhook. */
export function metaVerify(req: Request, res: Response) {
  const mode = String(req.query['hub.mode'] ?? '');
  const token = String(req.query['hub.verify_token'] ?? '');
  const challenge = String(req.query['hub.challenge'] ?? '');
  if (mode === 'subscribe' && config.metaVerifyToken && safeEqual(token, config.metaVerifyToken)) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
}

/**
 * Verifica X-Hub-Signature-256 (HMAC-SHA256 del body CRUDO con META_APP_SECRET) — prueba de que el
 * POST viene de Meta. Requiere que index.ts capture el body crudo (verify de express.json) en
 * `req.rawBody`. Fail-closed en producción si falta el secreto (igual que verifyBitrixEvent).
 */
export function verifyMetaSignature(req: Request, res: Response, next: NextFunction) {
  if (!config.metaAppSecret) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({ error: 'META_APP_SECRET no configurado' });
    }
    log.warn('verifyMetaSignature: sin META_APP_SECRET (fail-open solo en desarrollo)');
    return next();
  }
  const header = req.header('x-hub-signature-256') ?? '';
  const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (!raw) {
    log.error('verifyMetaSignature: falta rawBody (falta el verify de express.json en index.ts)');
    return res.status(500).json({ error: 'rawBody no disponible' });
  }
  const expected = 'sha256=' + crypto.createHmac('sha256', config.metaAppSecret).update(raw).digest('hex');
  if (!safeEqual(header, expected)) return res.status(401).json({ error: 'unauthorized' });
  next();
}

/** POST /webhooks/meta — recibe mensajes de Instagram/Messenger. ACK inmediato (Meta reintenta si no
 *  responde 200 rápido) y procesa en segundo plano, igual que el webhook del bot de Bitrix. */
export async function metaWebhook(req: Request, res: Response) {
  res.sendStatus(200);
  void handleBody(req.body).catch((e) => log.error('metaWebhook: error', { err: String(e) }));
}

/** Procesa el body del webhook (exportado para tests: permite awaitear el fire-and-forget de metaWebhook). */
export async function handleBody(body: any): Promise<void> {
  const canal: MetaChannel = body?.object === 'instagram' ? 'instagram' : 'messenger';
  const entries: any[] = Array.isArray(body?.entry) ? body.entry : [];
  for (const entry of entries) {
    const events: any[] = Array.isArray(entry?.messaging) ? entry.messaging : [];
    for (const ev of events) {
      await handleEvent(ev, canal).catch((e) => log.error('metaWebhook: evento falló', { canal, err: String(e) }));
    }
  }
}

async function handleEvent(ev: any, canal: MetaChannel): Promise<void> {
  if (ev?.message?.is_echo) return; // eco de un mensaje que NOSOTROS enviamos; ignorar
  const psid: string | undefined = ev?.sender?.id;
  const text: string | undefined = ev?.message?.text;
  const mid: string | undefined = ev?.message?.mid;
  if (!psid || !text) return; // sin texto (adjunto, postback, delivery/read receipt...): se ignora

  if (mid && !(await once(`meta:msg:${mid}`, 3600))) {
    return log.info('metaWebhook: evento duplicado ignorado', { canal, mid });
  }

  log.info('INBOUND meta message', { canal, psid, mid });
  const st = await getState();
  const auth = st.auth ?? EMPTY_AUTH;
  const reply = await metaTurn(psid, text, auth, canal);
  await sendMetaMessage(psid, reply);
  log.info('REPLY enviado (meta)', { canal, psid });
}

/** Envía un mensaje de texto vía la Send API de Meta (mismo endpoint para Messenger e Instagram
 *  cuando la cuenta IG está vinculada a la Página dueña del Page Access Token). */
async function sendMetaMessage(psid: string, text: string): Promise<void> {
  if (!config.metaPageAccessToken) {
    log.warn('sendMetaMessage: falta META_PAGE_ACCESS_TOKEN; no se pudo responder', { psid });
    return;
  }
  try {
    const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(config.metaPageAccessToken)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: psid }, message: { text }, messaging_type: 'RESPONSE' }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      log.warn('sendMetaMessage: Meta rechazó el envío', { status: res.status, body: errBody.slice(0, 500) });
    }
  } catch (e) {
    log.error('sendMetaMessage falló', { err: String(e) });
  }
}
