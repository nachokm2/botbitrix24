import type { Request, Response } from 'express';
import crypto from 'crypto';
import { runConversation } from '../ai/agentLoop';
import { VOICE_PROFILE, type AgentContext } from '../core/channel';
import { getVoiceCtx, runVapiTool } from '../voice/vapiTools';
import { primaryEntity } from '../crm/entities';
import { getState, EMPTY_AUTH } from '../store';
import { log } from '../log';

// ── M2: Vapi en modo "Custom LLM" ──
// En vez de que Vapi corra su propio Claude (modelo nativo), Vapi hace SOLO STT/TTS/turn-taking y en
// cada turno llama a ESTE endpoint (compatible con OpenAI /chat/completions). Aquí corremos el MISMO
// motor conversacional que WhatsApp (runConversation) con el perfil de VOZ, ejecutando las tools de voz.
// Así el prompt/tools/lógica dejan de vivir duplicados en el dashboard de Vapi: una sola fuente de verdad.
//
// Es ADITIVO: /vapi/events (modo nativo) sigue funcionando como fallback. Para activar Custom LLM,
// se apunta el asistente de Vapi (model.provider="custom-llm", model.url) a /vapi/llm.
// Doc: https://docs.vapi.ai/customization/custom-llm/using-your-server

/** Convierte los mensajes OpenAI (de Vapi) a mensajes Anthropic: solo user/assistant, contenido texto,
 *  empezando por un turno de 'user' (requisito de la API de Anthropic). El system lo aporta el perfil. */
function toAnthropicMessages(openaiMsgs: any[]): any[] {
  const msgs = (Array.isArray(openaiMsgs) ? openaiMsgs : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, content: textOfContent(m.content) }))
    .filter((m) => m.content.trim().length > 0);
  // Anthropic exige que el primer mensaje sea 'user'; descarta saludos iniciales del asistente.
  const firstUser = msgs.findIndex((m) => m.role === 'user');
  return firstUser <= 0 ? msgs.slice(firstUser < 0 ? msgs.length : 0) : msgs.slice(firstUser);
}

function textOfContent(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join(' ');
  }
  return '';
}

function chunkId(): string {
  return 'chatcmpl-' + crypto.randomUUID();
}

/** Respuesta OpenAI no-streaming. */
function completionBody(text: string, model: string) {
  return {
    id: chunkId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/** Respuesta OpenAI en streaming (SSE): un delta con el texto final + [DONE]. Vapi lo pasa a TTS. */
function streamCompletion(res: Response, text: string, model: string) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const id = chunkId();
  const created = Math.floor(Date.now() / 1000);
  const frame = (delta: any, finish: string | null) =>
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  res.write(frame({ role: 'assistant' }, null));
  res.write(frame({ content: text }, null));
  res.write(frame({}, 'stop'));
  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * Endpoint Custom LLM de Vapi (OpenAI-compatible). Corre el motor con el perfil de voz.
 */
export async function vapiChatCompletions(req: Request, res: Response) {
  const body: any = req.body ?? {};
  const stream = body.stream === true;
  const call = body.call ?? {};
  const callId = String(call.id ?? body.callId ?? 'unknown');
  const phone: string | undefined =
    call.customer?.number ?? body.customer?.number ?? body.phoneNumber?.number ?? undefined;

  const st = await getState();
  const auth = st.auth ?? EMPTY_AUTH;

  try {
    // Resuelve (y cachea) el contexto CRM de la llamada por teléfono, igual que el modo nativo.
    const voiceCtx = await getVoiceCtx(callId, phone, auth);
    const ctx: AgentContext = {
      profile: VOICE_PROFILE,
      auth,
      conversationId: callId,
      crmEntities: voiceCtx.crm ?? {},
      crmEntity: primaryEntity(voiceCtx.crm ?? {}),
      phone,
    };

    const messages = toAnthropicMessages(body.messages);
    if (messages.length === 0) {
      // Sin turno de usuario todavía (p. ej. apertura): devuelve un saludo sin invocar al modelo.
      const saludo = '¡Hola! Le saluda el asistente de Postgrados de la Universidad Autónoma de Chile. ¿En qué le puedo ayudar?';
      return stream ? streamCompletion(res, saludo, VOICE_PROFILE.model) : res.json(completionBody(saludo, VOICE_PROFILE.model));
    }

    const { text } = await runConversation(
      { profile: VOICE_PROFILE, auditId: callId, crmEntity: ctx.crmEntity },
      messages,
      (name, input) => runVapiTool(name, input, voiceCtx, auth),
    );

    log.info('vapi custom-llm turno', { callId, stream, tExtractoLen: text.length });
    return stream ? streamCompletion(res, text, VOICE_PROFILE.model) : res.json(completionBody(text, VOICE_PROFILE.model));
  } catch (e) {
    log.error('vapiChatCompletions error', { callId, err: String(e) });
    const fallback = 'Disculpe, tuve un inconveniente. ¿Podría repetir, por favor?';
    return stream ? streamCompletion(res, fallback, VOICE_PROFILE.model) : res.json(completionBody(fallback, VOICE_PROFILE.model));
  }
}
