import type { Request, Response, NextFunction } from 'express';
import { getState } from '../store';
import { callCrm } from '../bitrix/client';
import { config } from '../config';
import { log } from '../log';
import { registerCall, finishCall, attachCallRecord, toCrmRef, type CallType } from '../crm/telephony';
import { getVoiceCtx, runVapiTool } from '../voice/vapiTools';
import { iniciarLlamadaSaliente } from '../voice/outbound';

// Webhook único que recibe los "server messages" de Vapi (tool-calls, end-of-call-report, etc.).
// Vapi corre la conversación (STT/TTS/Claude); aquí ejecutamos herramientas y registramos en Bitrix.
// Doc: https://docs.vapi.ai/server-url/events · https://docs.vapi.ai/tools/custom-tools

/** Valida el secreto del servidor de Vapi (header x-vapi-secret), si está configurado. */
export function verifyVapiSecret(req: Request, res: Response, next: NextFunction) {
  if (!config.vapiSecret) return next();
  if (req.header('x-vapi-secret') !== config.vapiSecret) return res.status(401).json({ error: 'unauthorized' });
  next();
}

export async function vapiEvents(req: Request, res: Response) {
  const message: any = (req.body as any)?.message ?? {};
  const type: string = message.type ?? '';
  const st = await getState();
  const auth = st.auth ?? ({} as any);

  try {
    if (type === 'tool-calls') {
      const call = message.call ?? {};
      const phone: string | undefined = call.customer?.number;
      const ctx = await getVoiceCtx(call.id ?? 'unknown', phone, auth);
      const toolCalls: any[] = message.toolCallList ?? message.toolCalls ?? [];
      // Diagnóstico: estructura cruda de la tool-call que envía Vapi (para ver si los args llegan vacíos).
      log.info('vapi tool-calls payload', { count: toolCalls.length, raw: JSON.stringify(toolCalls).slice(0, 1500) });
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
        results.push({ toolCallId: tc.id ?? fn.id, result: JSON.stringify(result) });
      }
      return res.json({ results });
    }

    if (type === 'end-of-call-report') {
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
}

/** Dispara una llamada SALIENTE con Vapi (p. ej. al detectarse un lead caliente). */
export async function voiceOutbound(req: Request, res: Response) {
  const phone = String((req.body as any)?.phone ?? '').trim();
  if (!phone) return res.status(400).json({ ok: false, error: 'Falta phone (E.164, ej. +56912345678)' });
  const r = await iniciarLlamadaSaliente(phone);
  if (!r.ok) return res.status(502).json({ ok: false, error: r.error });
  return res.json({ ok: true, callId: r.callId ?? null });
}
