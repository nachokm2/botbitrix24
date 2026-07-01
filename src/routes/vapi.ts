import type { Request, Response, NextFunction } from 'express';
import { getState } from '../store';
import { callCrm } from '../bitrix/client';
import { config } from '../config';
import { log } from '../log';
import { registerCall, finishCall, attachCallRecord, type CallType } from '../crm/telephony';
import { getVoiceCtx, runVapiTool } from '../voice/vapiTools';

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
  const reg = await registerCall({ phone, type, userId: config.voiceUserId, crm: ctx.crm, crmCreate: true }, auth);
  if (reg.callId) {
    await finishCall({ callId: reg.callId, userId: config.voiceUserId, duration, statusCode: duration > 0 ? '200' : '304' }, auth);
    if (recordingUrl) await attachCallRecord({ callId: reg.callId, recordUrl: recordingUrl }, auth);
  }

  const entity = reg.crm ?? ctx.crm;
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
  if (!config.vapiApiKey || !config.vapiAssistantId || !config.vapiPhoneNumberId) {
    return res.status(400).json({ ok: false, error: 'Faltan VAPI_API_KEY / VAPI_ASSISTANT_ID / VAPI_PHONE_NUMBER_ID' });
  }
  try {
    const r = await fetch('https://api.vapi.ai/call', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.vapiApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assistantId: config.vapiAssistantId,
        phoneNumberId: config.vapiPhoneNumberId,
        customer: { number: phone },
      }),
    });
    const json: any = await r.json();
    if (!r.ok) return res.status(502).json({ ok: false, error: json });
    return res.json({ ok: true, callId: json.id ?? json.callId ?? null });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
