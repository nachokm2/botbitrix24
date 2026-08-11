import type { Request, Response } from 'express';
import crypto from 'crypto';
import { runConversation, runConversationStream, priorContextMessage, type ConversationOpts, type ToolExecutor } from '../ai/agentLoop';
import { VOICE_PROFILE, type AgentContext } from '../core/channel';
import { VOICE_OUTBOUND_MMD } from '../campaign/prompt.mmd';
import { getVoiceCtx, runVapiTool } from '../voice/vapiTools';
import { primaryEntity } from '../crm/entities';
import { loadPriorContext } from '../crm/chat';
import { obtenerContextoLlamada } from '../crm/crmWrite';
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
 * Corre el motor en STREAMING y va enviando cada delta del modelo como chunk SSE, para que Vapi empiece
 * a hablar (TTS) con las primeras palabras en vez de esperar la respuesta completa (menor latencia).
 */
async function streamConversationToVapi(
  res: Response,
  opts: ConversationOpts,
  messages: any[],
  execTool: ToolExecutor,
  model: string,
): Promise<void> {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const id = chunkId();
  const created = Math.floor(Date.now() / 1000);
  const frame = (delta: any, finish: string | null) =>
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  res.write(frame({ role: 'assistant' }, null));
  try {
    await runConversationStream(opts, messages, execTool, (delta) => {
      if (delta) res.write(frame({ content: delta }, null));
    });
  } catch (e) {
    log.error('vapi streaming error', { err: String(e) });
    res.write(frame({ content: 'Disculpe, tuve un inconveniente. ¿Podría repetir, por favor?' }, null));
  }
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

  // Metadata de campaña (viaja en la creación de la llamada Vapi → call.metadata). Selecciona el perfil:
  // saliente MMD si programCode === 'MMD'; si no, el inbound por defecto ("Sofía" que atiende).
  const meta = (call.metadata ?? body.metadata ?? {}) as {
    programCode?: string; dealId?: number | string; contactId?: number | string; leadId?: number | string;
  };
  const programCode = meta.programCode ? String(meta.programCode) : undefined;
  const dealId = Number(meta.dealId) || undefined;
  const contactId = Number(meta.contactId) || undefined;
  const leadId = Number(meta.leadId) || undefined;
  const profile = programCode === 'MMD' ? VOICE_OUTBOUND_MMD : VOICE_PROFILE;

  const st = await getState();
  const auth = st.auth ?? EMPTY_AUTH;

  try {
    // Resuelve (y cachea) el contexto CRM de la llamada. En saliente prioriza el dealId de la metadata.
    const voiceCtx = await getVoiceCtx(callId, phone, auth, { programCode, dealId, contactId, leadId });
    const ctx: AgentContext = {
      profile,
      auth,
      conversationId: callId,
      crmEntities: voiceCtx.crm ?? {},
      crmEntity: primaryEntity(voiceCtx.crm ?? {}),
      phone,
    };

    const messages = toAnthropicMessages(body.messages);
    if (messages.length === 0) {
      // Sin turno de usuario todavía (p. ej. apertura): devuelve un saludo sin invocar al modelo.
      const saludo = '¡Hola! Te saluda Sofía, asistente de Postgrados de la Universidad Autónoma de Chile. ¿En qué te puedo ayudar?';
      return stream ? streamCompletion(res, saludo, profile.model) : res.json(completionBody(saludo, profile.model));
    }

    // Primer turno real de la llamada (aún sin respuesta nuestra): si hay entidad CRM, personaliza.
    // ENTRANTE: el CallerID resolvió al contacto/lead por teléfono → inyectamos su nombre/programa para
    // que Sofía salude por su nombre y no vuelva a pedir datos; + las notas de conversaciones previas
    // (mismo mecanismo que WhatsApp). Ambas consultas en paralelo para no sumar latencia al primer turno.
    const esPrimerTurno = !messages.some((m) => m.role === 'assistant');
    if (esPrimerTurno && ctx.crmEntity) {
      const [contexto, priorContext] = await Promise.all([
        obtenerContextoLlamada(voiceCtx.crm ?? {}, auth).catch(() => ({} as { nombre?: string; programa?: string })),
        loadPriorContext(ctx.crmEntity, auth),
      ]);
      const notas: string[] = [];
      if (contexto?.nombre || contexto?.programa) {
        const partes = [
          contexto.nombre ? `se llama ${contexto.nombre}` : null,
          contexto.programa ? `mostró interés en ${contexto.programa}` : null,
        ]
          .filter(Boolean)
          .join(' y ');
        notas.push(
          `El cliente que está llamando (identificado por su número de WhatsApp) ${partes}. ` +
            `IMPORTANTE: el saludo inicial de la llamada YA se dio, así que NO vuelvas a saludar ni a ` +
            `presentarte; ve directo a ayudar, tuteándolo (de "tú") y usando su nombre con naturalidad. ` +
            `No vuelvas a pedir estos datos.`,
        );
      }
      if (priorContext) notas.push(priorContext);
      if (notas.length) messages.unshift(priorContextMessage(notas.join('\n---\n')));
    }

    const exec: ToolExecutor = (name, input) => runVapiTool(name, input, voiceCtx, auth, profile);
    const convOpts: ConversationOpts = { profile, auditId: callId, crmEntity: ctx.crmEntity };

    if (stream) {
      // Camino streaming: la voz empieza a hablar con las primeras palabras (menor latencia percibida).
      await streamConversationToVapi(res, convOpts, messages, exec, profile.model);
      log.info('vapi custom-llm turno (stream)', { callId, programCode: programCode ?? null });
      return;
    }

    const { text } = await runConversation(convOpts, messages, exec);
    log.info('vapi custom-llm turno', { callId, stream: false, programCode: programCode ?? null, tExtractoLen: text.length });
    return res.json(completionBody(text, profile.model));
  } catch (e) {
    log.error('vapiChatCompletions error', { callId, err: String(e) });
    const fallback = 'Disculpe, tuve un inconveniente. ¿Podría repetir, por favor?';
    return stream ? streamCompletion(res, fallback, profile.model) : res.json(completionBody(fallback, profile.model));
  }
}
