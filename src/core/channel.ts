import { config } from '../config';
import { SYSTEM_PROMPT } from '../ai/prompt';
import type { ConsultarPresentation, DetalleShape } from './catalogTool';
import type { Auth } from '../store';
import type { CrmEntity, CrmEntities } from '../crm/entities';

// Núcleo omnicanal (M1). Un ÚNICO motor conversacional; cada canal es un adaptador que solo traduce
// el formato de entrada/salida y aporta su PERFIL (tono, longitud de respuesta, capacidades, tools).
// Esto materializa el requisito de Fase 4: "cada canal con su experiencia, manteniendo el mismo motor".

export type ChannelId = 'whatsapp' | 'voice' | 'webchat' | 'instagram' | 'messenger';

/**
 * Configuración específica de un canal. Declara CÓMO se comporta y presenta, sin duplicar el motor.
 * Los campos de orquestación (systemPrompt/model/maxResponseTokens/toolNames) los usa el orquestador
 * propio (hoy: chat; en M2 también voz vía Custom LLM). Los de `catalog` los usan las tools de catálogo.
 */
export type ChannelProfile = {
  id: ChannelId;
  label: string;
  /** Modelo Claude que usa el orquestador para este canal. */
  model: string;
  /** Tope de tokens de la respuesta (proxy de "longitud de respuesta" del canal). */
  maxResponseTokens: number;
  /** Prompt de sistema con el tono y las reglas del canal. */
  systemPrompt: string;
  /** Herramientas habilitadas para el canal (subconjunto del registro). */
  toolNames: string[];
  /** Presentación de las tools de catálogo (top-N, verbosidad, notas). */
  catalog: {
    consultar: ConsultarPresentation;
    detalle: DetalleShape;
  };
};

/**
 * Contexto de un turno, INDEPENDIENTE del canal. El adaptador de cada canal lo construye a partir de
 * su payload (evento de Bitrix, tool-call de Vapi, mensaje de webchat, webhook de Meta) y se lo pasa
 * al motor. `conversationId` es el identificador estable de la conversación en ese canal.
 */
export type AgentContext = {
  profile: ChannelProfile;
  auth: Auth;
  conversationId: string;
  crmEntities: CrmEntities;
  crmEntity?: CrmEntity | null;
  // Handles específicos del canal (opcionales; los usa cada adaptador/tool cuando aplica):
  chatId?: string | number; // chat (Open Lines)
  botId?: number; // chat
  phone?: string; // voz
};

// El prompt de voz vive HOY en el dashboard de Vapi (modelo nativo). Se replica aquí para que, al
// migrar voz a Custom LLM (M2), el motor use esta MISMA fuente de verdad y deje de divergir.
const VOICE_SYSTEM_PROMPT_M2 = `Asistente de voz de Postgrados, Universidad Autónoma de Chile. Español de Chile, cálido. Respuestas de 1–2 frases, una pregunta a la vez, sin URLs ni listas. Responde sobre programas, aranceles y requisitos SOLO con las herramientas; si un dato no aparece, dilo y ofrece derivar a un asesor; nunca inventes nombres, precios ni fechas. Pide en orden: nombre, luego correo, luego teléfono, y guárdalos con 'registrar_interes_crm' apenas los tengas. Si piden un asesor o hay interés alto, usa 'transferir_a_asesor' (nombra al asesor si la herramienta lo devuelve; nunca lo inventes). Al terminar, despídete corto.`;

const MORE_NOTE_CHAT = 'Hay más resultados; pide al usuario que afine por facultad o tema.';
const MORE_NOTE_VOICE = 'Hay más resultados; pide afinar por facultad o tema.';
const EMPTY_NOTE_VOICE = 'No hay coincidencias; sugiere afinar el tema o derivar a un asesor. No inventes programas.';

/** WhatsApp (Open Lines): el adaptador de referencia. Comportamiento idéntico al histórico. */
export const WHATSAPP_PROFILE: ChannelProfile = {
  id: 'whatsapp',
  label: 'WhatsApp (Open Lines)',
  model: config.model, // Claude Sonnet
  maxResponseTokens: 1024,
  systemPrompt: SYSTEM_PROMPT,
  toolNames: ['consultar_programas', 'detalle_programa', 'registrar_interes_crm', 'solicitar_llamada', 'escalar_a_humano'],
  catalog: {
    consultar: { limit: 20, verbose: true, wrapOk: true, moreNote: MORE_NOTE_CHAT },
    detalle: 'full',
  },
};

/** Voz (Vapi): hoy Vapi corre el LLM (modelo nativo); el perfil solo shapea las tools. En M2 el motor
 *  propio usará systemPrompt/model/maxResponseTokens vía Custom LLM. */
export const VOICE_PROFILE: ChannelProfile = {
  id: 'voice',
  label: 'Voz (Vapi)',
  model: config.classifierModel, // Claude Haiku (latencia); usado a partir de M2
  maxResponseTokens: 150,
  systemPrompt: VOICE_SYSTEM_PROMPT_M2,
  toolNames: ['consultar_programas', 'detalle_programa', 'registrar_interes_crm', 'transferir_a_asesor'],
  catalog: {
    consultar: { limit: 8, verbose: false, wrapOk: false, moreNote: MORE_NOTE_VOICE, emptyNote: EMPTY_NOTE_VOICE },
    detalle: 'voice',
  },
};

const PROFILES: Record<ChannelId, ChannelProfile | undefined> = {
  whatsapp: WHATSAPP_PROFILE,
  voice: VOICE_PROFILE,
  webchat: undefined, // M3
  instagram: undefined, // M4
  messenger: undefined, // M4
};

export function profileFor(id: ChannelId): ChannelProfile {
  const p = PROFILES[id];
  if (!p) throw new Error(`Canal sin perfil configurado: ${id}`);
  return p;
}
