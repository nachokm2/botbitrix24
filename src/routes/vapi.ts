import type { Request, Response } from 'express';
import { verifyHeaderSecret } from './verifySecret';
import { getState, EMPTY_AUTH } from '../store';
import { once } from '../store/kv';
import { callCrm } from '../bitrix/client';
import { config } from '../config';
import { log } from '../log';
import { audit } from '../obs/audit';
import { registerCall, finishCall, attachCallRecord, toCrmRef, type CallType } from '../crm/telephony';
import { getVoiceCtx, runVapiTool } from '../voice/vapiTools';
import { iniciarLlamadaSaliente } from '../voice/outbound';

// Webhook único que recibe los "server messages" de Vapi (tool-calls, end-of-call-report, etc.).
// Vapi corre la conversación (STT/TTS/Claude); aquí ejecutamos herramientas y registramos en Bitrix.
// Doc: https://docs.vapi.ai/server-url/events · https://docs.vapi.ai/tools/custom-tools

/** Valida el secreto del servidor de Vapi (header x-vapi-secret). Timing-safe; fail-closed en producción. */
export const verifyVapiSecret = verifyHeaderSecret('x-vapi-secret');

export async function vapiEvents(req: Request, res: Response) {
  const message: any = (req.body as any)?.message ?? {};
  const type: string = message.type ?? '';
  const st = await getState();
  const auth = st.auth ?? EMPTY_AUTH;

  try {
    if (type === 'tool-calls') {
      const call = message.call ?? {};
      const phone: string | undefined = call.customer?.number;
      const ctx = await getVoiceCtx(call.id ?? 'unknown', phone, auth);
      const toolCalls: any[] = message.toolCallList ?? message.toolCalls ?? [];
      // Diagnóstico: estructura cruda de la tool-call (solo bajo DEBUG_VAPI=1; puede contener PII).
      if (process.env.DEBUG_VAPI === '1') {
        log.info('vapi tool-calls payload', { count: toolCalls.length, raw: JSON.stringify(toolCalls).slice(0, 1500) });
      } else {
        log.info('vapi tool-calls', { count: toolCalls.length });
      }
      const results: any[] = [];
      for (const tc of toolCalls) {
        const fn = tc.function ?? tc;
        let args = fn.arguments;
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args);
          } catch {
            args = {};
          }
        }
        log.info('vapi tool-call', { name: fn.name, argsType: typeof fn.arguments, args: args ?? null });
        const result = await runVapiTool(fn.name, args, ctx, auth);
        void audit({ type: 'voice_tool', detail: { name: fn.name, callId: call.id ?? null, ok: (result as any)?.ok } });
        results.push({ toolCallId: tc.id ?? fn.id, result: JSON.stringify(result) });
      }
      return res.json({ results });
    }

    if (type === 'end-of-call-report') {
      // Idempotencia: descarta reintentos/duplicados del mismo call.id (evita llamada/lead/nota dobles).
      const callId = String((message.call ?? {}).id ?? '');
      if (callId && !(await once(`vapi:eoc:${callId}`, 24 * 3600))) {
        return res.json({ ok: true, dup: true });
      }
      await handleEndOfCall(message, auth);
      return res.json({ ok: true });
    }

    // status-update, transcript, conversation-update, etc.: solo acuse.
    return res.json({ ok: true });
  } catch (e) {
    log.error('vapiEvents error', { type, err: String(e) });
    return res.status(200).json({ ok: false }); // 200 para no reintentar en bucle
  }
}

/** Registra la llamada en el CRM al terminar: register → finish → attachRecord + nota con transcripción. */
async function handleEndOfCall(message: any, auth: any) {
  const call = message.call ?? {};
  const phone: string = call.customer?.number ?? 'desconocido';
  const type: CallType = call.type === 'outboundPhoneCall' ? 1 : 2;
  const duration = Math.round(message.durationSeconds ?? (message.durationMs ? message.durationMs / 1000 : 0));
  const recordingUrl: string | undefined = message.recordingUrl ?? message.artifact?.recordingUrl ?? message.recording?.url;
  const transcript: string | undefined = message.transcript ?? message.artifact?.transcript;

  if (!config.voiceUserId || !auth?.access_token) {
    log.warn('vapi endOfCall: falta BITRIX_TELEPHONY_USER_ID o auth OAuth; no se registra en Bitrix');
    return;
  }

  const ctx = await getVoiceCtx(call.id ?? 'unknown', phone, auth);
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
      { fields: { ENTITY_ID: entity.id, ENTITY_TYPE: entity.type.toLowerCase(), COMMENT: `📞 Llamada IA (voz)\n${String(transcript).slice(0, 4000)}` } },
      auth,
    ).catch((e) => log.warn('vapi endOfCall: nota transcripción falló', { err: String(e) }));
  }
  log.info('vapi: llamada registrada en CRM', { callId: reg.callId, duration, crm: entity });
  void audit({
    type: 'voice_call',
    crmEntity: entity ? `${entity.type}#${entity.id}` : undefined,
    detail: { callId: reg.callId ?? call.id ?? null, duration, type },
  });
}

/** Dispara una llamada SALIENTE con Vapi (p. ej. al detectarse un lead caliente). */
export async function voiceOutbound(req: Request, res: Response) {
  const phone = String((req.body as any)?.phone ?? '').trim();
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    return res.status(400).json({ ok: false, error: 'phone inválido: usa formato E.164 (ej. +56912345678)' });
  }
  const r = await iniciarLlamadaSaliente(phone);
  if (!r.ok) return res.status(502).json({ ok: false, error: r.error });
  return res.json({ ok: true, callId: r.callId ?? null });
}
