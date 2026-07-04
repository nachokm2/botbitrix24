import type { Request, Response, NextFunction } from 'express';
import { getState } from '../store';
import { callCrm } from '../bitrix/client';
import { config } from '../config';
import { log } from '../log';
import { getVoiceCtx, runVapiTool } from '../voice/vapiTools';
import { registerCall, finishCall, attachCallRecord, type CallType } from '../crm/telephony';

// API de voz genérica (transport-agnóstica) para el agente Pipecat self-hosted.
// - POST /voice/tool        → ejecuta una herramienta (catálogo/CRM/responsable) y devuelve el resultado.
// - POST /voice/call/finish → registra la llamada en el CRM (register→finish→attachRecord + transcripción).
// Reutiliza la misma lógica del bot (runVapiTool, telephony.externalCall.*).

/** Valida el secreto compartido con el servicio de voz (reusa VAPI_SECRET). */
export function verifyVoiceSecret(req: Request, res: Response, next: NextFunction) {
  if (!config.vapiSecret) return next();
  if (req.header('x-voice-secret') !== config.vapiSecret) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
}

/** Ejecuta una tool solicitada por el agente de voz (Pipecat). Body: { name, args, callId, phone }. */
export async function voiceTool(req: Request, res: Response) {
  const b: any = req.body ?? {};
  const name = String(b.name ?? '').trim();
  if (!name) return res.status(400).json({ ok: false, error: 'Falta name' });
  const st = await getState();
  const auth = st.auth ?? ({} as any);
  const ctx = await getVoiceCtx(String(b.callId ?? 'unknown'), b.phone ? String(b.phone) : undefined, auth);
  const result = await runVapiTool(name, b.args ?? {}, ctx, auth);
  res.json({ ok: true, result });
}

/** Registra la llamada en el CRM al terminar. Body: { callId, phone, type, duration, recordingUrl, transcript }. */
export async function voiceCallFinish(req: Request, res: Response) {
  const b: any = req.body ?? {};
  const callId = String(b.callId ?? '').trim();
  const phone = String(b.phone ?? 'desconocido');
  const type: CallType = Number(b.type) === 1 ? 1 : 2;
  const duration = Math.round(Number(b.duration) || 0);
  const recordingUrl = b.recordingUrl ? String(b.recordingUrl) : undefined;
  const transcript = b.transcript ? String(b.transcript) : undefined;

  const st = await getState();
  const auth = st.auth;
  if (!config.voiceUserId || !auth?.access_token) {
    log.warn('voiceCallFinish: falta BITRIX_TELEPHONY_USER_ID o auth OAuth');
    return res.json({ ok: false, error: 'Falta BITRIX_TELEPHONY_USER_ID o auth (scope telephony)' });
  }

  const ctx = await getVoiceCtx(callId || `p-${phone}`, phone, auth);
  const reg = await registerCall({ phone, type, userId: config.voiceUserId, crm: ctx.crm, crmCreate: true }, auth);
  if (reg.callId) {
    await finishCall({ callId: reg.callId, userId: config.voiceUserId, duration, statusCode: duration > 0 ? '200' : '304' }, auth);
    if (recordingUrl) await attachCallRecord({ callId: reg.callId, recordUrl: recordingUrl }, auth);
  }
  const entity = reg.crm ?? ctx.crm;
  if (transcript && entity) {
    await callCrm(
      'crm.timeline.comment.add',
      { fields: { ENTITY_ID: entity.id, ENTITY_TYPE: entity.type.toLowerCase(), COMMENT: `📞 Llamada IA (voz)\n${transcript.slice(0, 4000)}` } },
      auth,
    ).catch((e) => log.warn('voiceCallFinish: nota transcripción falló', { err: String(e) }));
  }
  log.info('voiceCallFinish: registrada en CRM', { callId: reg.callId, duration });
  res.json({ ok: true, callId: reg.callId });
}
