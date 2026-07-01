import type { Request, Response, NextFunction } from 'express';
import { getState } from '../store';
import { getJson, setJson, kvDel } from '../store/kv';
import { config } from '../config';
import { log } from '../log';
import { searchCrmByPhone, registerCall, finishCall, attachCallRecord, type CallType } from '../crm/telephony';
import { runVoiceTurn, type VoiceSession } from '../voice/voiceAgent';

// Endpoints que consume el escenario VoxEngine (Voximplant) por HTTP (Net.httpRequestAsync).
// Flujo: /voice/call/register (al contestar) → /voice/turn (por cada frase del usuario) → /voice/call/finish (al colgar).

const sessKey = (callId: string) => `voice:sess:${callId}`;
const SESSION_TTL = 2 * 60 * 60; // 2 h

/** Valida el secreto compartido (si está configurado) para asegurar que el request viene del escenario. */
export function verifyVoiceSecret(req: Request, res: Response, next: NextFunction) {
  if (!config.voiceSharedSecret) return next();
  const got = req.header('x-voice-secret');
  if (got !== config.voiceSharedSecret) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
}

/** Registra el inicio de la llamada en Bitrix, crea/vincula la entidad CRM y abre la sesión de voz. */
export async function voiceRegister(req: Request, res: Response) {
  const phone = String((req.body as any)?.phone ?? '').trim();
  const type = (Number((req.body as any)?.type) === 1 ? 1 : 2) as CallType; // 1 saliente, 2 entrante (default)
  const userId = Number((req.body as any)?.userId) || config.voiceUserId;
  if (!phone) return res.status(400).json({ ok: false, error: 'Falta phone' });
  if (!userId) return res.status(400).json({ ok: false, error: 'Falta BITRIX_TELEPHONY_USER_ID (o userId)' });

  const st = await getState();
  if (!st.auth) return res.status(400).json({ ok: false, error: 'Sin auth OAuth del app (instala/activa la app con scope telephony)' });

  const existing = await searchCrmByPhone(phone, st.auth);
  const reg = await registerCall({ phone, type, userId, crm: existing, crmCreate: true }, st.auth);

  const session: VoiceSession = { callId: reg.callId ?? `local-${phone}`, phone, userId, crm: reg.crm };
  await setJson(sessKey(session.callId), session, SESSION_TTL);
  log.info('voz: llamada registrada', { callId: session.callId, crm: reg.crm, type });

  const saludo =
    type === 1
      ? 'Hola, le llamamos de Postgrados de la Universidad Autónoma de Chile. ¿Le pillo en un buen momento para contarle sobre nuestros programas?'
      : 'Hola, le saluda el asistente de Postgrados de la Universidad Autónoma de Chile. ¿En qué le puedo ayudar?';

  res.json({ ok: true, callId: session.callId, crm: reg.crm, saludo });
}

/** Procesa una frase del usuario (texto reconocido por el ASR) y devuelve la respuesta + acción. */
export async function voiceTurn(req: Request, res: Response) {
  const callId = String((req.body as any)?.callId ?? '').trim();
  const text = String((req.body as any)?.text ?? '').trim();
  if (!callId || !text) return res.status(400).json({ ok: false, error: 'Faltan callId o text' });

  const session = await getJson<VoiceSession>(sessKey(callId));
  if (!session) return res.status(404).json({ ok: false, error: 'Sesión de voz no encontrada (¿registraste la llamada?)' });

  const st = await getState();
  const result = await runVoiceTurn(session, text, st.auth ?? ({} as any));
  res.json({ ok: true, reply: result.reply, action: result.action, transferTo: result.transferTo ?? null });
}

/** Cierra la llamada: la registra como actividad CRM y adjunta la grabación si la hay. */
export async function voiceFinish(req: Request, res: Response) {
  const callId = String((req.body as any)?.callId ?? '').trim();
  const duration = Number((req.body as any)?.duration) || 0;
  const statusCode = (req.body as any)?.statusCode ? String((req.body as any).statusCode) : undefined;
  const recordUrl = (req.body as any)?.recordUrl ? String((req.body as any).recordUrl) : undefined;
  if (!callId) return res.status(400).json({ ok: false, error: 'Falta callId' });

  const session = await getJson<VoiceSession>(sessKey(callId));
  const st = await getState();
  if (session && st.auth) {
    await finishCall({ callId, userId: session.userId, duration, statusCode }, st.auth);
    if (recordUrl) await attachCallRecord({ callId, recordUrl }, st.auth);
  }
  await kvDel(sessKey(callId));
  log.info('voz: llamada finalizada', { callId, duration });
  res.json({ ok: true });
}
