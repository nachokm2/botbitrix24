import type { Request, Response } from 'express';
import { verifyHeaderSecret } from './verifySecret';
import { getState, EMPTY_AUTH } from '../store';
import { callCrm } from '../bitrix/client';
import { config } from '../config';
import { log } from '../log';
import { audit } from '../obs/audit';
import { getVoiceCtx, runVapiTool } from '../voice/vapiTools';
import { registerCall, finishCall, attachCallRecord, toCrmRef, type CallType } from '../crm/telephony';

// API de voz genérica (transport-agnóstica) para el agente Pipecat self-hosted.
// - POST /voice/tool        → ejecuta una herramienta (catálogo/CRM/responsable) y devuelve el resultado.
// - POST /voice/call/finish → registra la llamada en el CRM (register→finish→attachRecord + transcripción).
// Reutiliza la misma lógica del bot (runVapiTool, telephony.externalCall.*).

/** Valida el secreto compartido con el servicio de voz (reusa VAPI_SECRET). Timing-safe; fail-closed en producción. */
export const verifyVoiceSecret = verifyHeaderSecret('x-voice-secret');

/** Ejecuta una tool solicitada por el agente de voz (Pipecat). Body: { name, args, callId, phone }. */
export async function voiceTool(req: Request, res: Response) {
  const b: any = req.body ?? {};
  const name = String(b.name ?? '').trim();
  if (!name) return res.status(400).json({ ok: false, error: 'Falta name' });
  const st = await getState();
  const auth = st.auth ?? EMPTY_AUTH;
  const ctx = await getVoiceCtx(String(b.callId ?? 'unknown'), b.phone ? String(b.phone) : undefined, auth);
  const result = await runVapiTool(name, b.args ?? {}, ctx, auth);
  void audit({ type: 'voice_tool', detail: { name, callId: String(b.callId ?? '') || null, ok: (result as any)?.ok } });
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
  const crmRef = toCrmRef(ctx.crm);
  const reg = await registerCall({ phone, type, userId: config.voiceUserId, crm: crmRef, crmCreate: true }, auth);
  if (reg.callId) {
    await finishCall({ callId: reg.callId, userId: config.voiceUserId, duration, statusCode: duration > 0 ? '200' : '304' }, auth);
    if (recordingUrl) await attachCallRecord({ callId: reg.callId, recordUrl: recordingUrl }, auth);
  }
  const entity = reg.crm ?? crmRef;
  if (transcript && entity) {
    await callCrm(
      'crm.timeline.comment.add',
      { fields: { ENTITY_ID: entity.id, ENTITY_TYPE: entity.type.toLowerCase(), COMMENT: `📞 Llamada IA (voz)\n${transcript.slice(0, 4000)}` } },
      auth,
    ).catch((e) => log.warn('voiceCallFinish: nota transcripción falló', { err: String(e) }));
  }
  log.info('voiceCallFinish: registrada en CRM', { callId: reg.callId, duration });
  void audit({
    type: 'voice_call',
    crmEntity: entity ? `${entity.type}#${entity.id}` : undefined,
    detail: { callId: reg.callId ?? null, duration, type },
  });
  res.json({ ok: true, callId: reg.callId });
}
