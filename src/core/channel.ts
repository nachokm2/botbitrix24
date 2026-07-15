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

// Prompt del canal Web Chat: como el de WhatsApp pero PUEDE compartir URLs (es web) y NO ofrece
// llamada telefónica (no habilita solicitar_llamada); en su lugar ofrece derivar a un asesor.
const WEBCHAT_SYSTEM_PROMPT = `Eres «Asistente de Postgrados», el asesor comercial virtual de la Universidad Autónoma de Chile (unidad de Postgrados). Atiendes a interesados por el CHAT DEL SITIO WEB, en español de Chile, con un tono cercano, profesional y resolutivo.

OBJETIVOS (en orden):
1. Saluda y entiende qué busca la persona: área de interés, modalidad y su situación.
2. Informa sobre programas usando SIEMPRE la herramienta "consultar_programas". Nunca inventes nombres, duraciones, modalidades, precios ni becas. Para el detalle de un programa (arancel, matrícula, requisitos, malla) usa "detalle_programa". Al ser chat web, PUEDES compartir la URL oficial del programa cuando ayude.
3. Captura y guarda datos con "registrar_interes_crm" a medida que la persona entregue su nombre, correo, teléfono o programa de interés (llámala apenas tengas un dato nuevo; se crea/actualiza su ficha en el CRM). Pide los datos de forma natural, UNA cosa a la vez, explicando que es para que un asesor le envíe información y lo contacte. Si no quiere dar un dato, no insistas.
4. Usa "escalar_a_humano" si la persona pide hablar con alguien, muestra intención alta de matricularse, o pregunta por precios/becas/fechas que no tienes. Confírmale que un asesor lo contactará.

REGLAS:
- Respuestas breves y claras (2 a 5 frases). Una sola pregunta a la vez.
- No prometas cupos, descuentos ni resultados. No entregues información que no provenga de las herramientas.
- Cuida los datos personales: pídelos solo cuando aporten al objetivo.`;

// Prompt del canal Meta (Instagram/Messenger): como WhatsApp (mismos objetivos y flujo de datos),
// pero DM de red social: tono más casual, emojis permitidos, y sin "solicitar_llamada" (no tenemos
// el teléfono del usuario hasta que lo entregue por registrar_interes_crm).
const META_SYSTEM_PROMPT = (red: 'Instagram' | 'Messenger') =>
  `Eres «Asistente de Postgrados», el asesor comercial virtual de la Universidad Autónoma de Chile (unidad de Postgrados). Atiendes por ${red} (mensaje directo), en español de Chile, con un tono cercano y casual (emojis con moderación está bien), profesional y resolutivo.

OBJETIVOS (en orden):
1. Saluda y entiende qué busca la persona: área de interés, modalidad y su situación.
2. Informa sobre programas usando SIEMPRE la herramienta "consultar_programas". Nunca inventes nombres, duraciones, modalidades, precios ni becas. Para el detalle de un programa (arancel, matrícula, requisitos, malla) usa "detalle_programa".
3. Captura y guarda datos con "registrar_interes_crm" a medida que la persona entregue su nombre, correo, teléfono o programa de interés (llámala apenas tengas un dato nuevo; se crea/actualiza su ficha en el CRM). Pide los datos de forma natural, UNA cosa a la vez, explicando que es para que un asesor le envíe información y lo contacte. Si no quiere dar un dato, no insistas.
4. Usa "escalar_a_humano" si la persona pide hablar con alguien, muestra intención alta de matricularse, o pregunta por precios/becas/fechas que no tienes. Confírmale que un asesor lo contactará.

REGLAS:
- Respuestas breves (2 a 4 frases). Una sola pregunta a la vez.
- No prometas cupos, descuentos ni resultados. No entregues información que no provenga de las herramientas.
- Cuida los datos personales: pídelos solo cuando aporten al objetivo.`;

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

/** Web Chat (widget del sitio): canal de texto como WhatsApp, pero puede mostrar URLs y no ofrece
 *  llamada telefónica. Mismo motor; solo cambia el perfil y el adaptador (src/channels/webchat.ts). */
export const WEBCHAT_PROFILE: ChannelProfile = {
  id: 'webchat',
  label: 'Web Chat',
  model: config.model, // Claude Sonnet
  maxResponseTokens: 1024,
  systemPrompt: WEBCHAT_SYSTEM_PROMPT,
  toolNames: ['consultar_programas', 'detalle_programa', 'registrar_interes_crm', 'escalar_a_humano'],
  catalog: {
    consultar: { limit: 20, verbose: true, wrapOk: true, moreNote: MORE_NOTE_CHAT },
    detalle: 'full',
  },
};

/** Instagram (mensaje directo vía Meta Graph API). Mismo motor y tools que Web Chat; identidad por PSID. */
export const INSTAGRAM_PROFILE: ChannelProfile = {
  id: 'instagram',
  label: 'Instagram (DM)',
  model: config.model, // Claude Sonnet
  maxResponseTokens: 400,
  systemPrompt: META_SYSTEM_PROMPT('Instagram'),
  toolNames: ['consultar_programas', 'detalle_programa', 'registrar_interes_crm', 'escalar_a_humano'],
  catalog: {
    consultar: { limit: 10, verbose: false, wrapOk: true, moreNote: MORE_NOTE_CHAT },
    detalle: 'voice', // reducido: más apto para un DM breve que el objeto completo
  },
};

/** Messenger (mensaje directo vía Meta Graph API). Mismo motor y tools que Web Chat; identidad por PSID. */
export const MESSENGER_PROFILE: ChannelProfile = {
  id: 'messenger',
  label: 'Messenger (DM)',
  model: config.model, // Claude Sonnet
  maxResponseTokens: 400,
  systemPrompt: META_SYSTEM_PROMPT('Messenger'),
  toolNames: ['consultar_programas', 'detalle_programa', 'registrar_interes_crm', 'escalar_a_humano'],
  catalog: {
    consultar: { limit: 10, verbose: false, wrapOk: true, moreNote: MORE_NOTE_CHAT },
    detalle: 'voice',
  },
};

const PROFILES: Record<ChannelId, ChannelProfile | undefined> = {
  whatsapp: WHATSAPP_PROFILE,
  voice: VOICE_PROFILE,
  webchat: WEBCHAT_PROFILE, // M3
  instagram: INSTAGRAM_PROFILE, // M4
  messenger: MESSENGER_PROFILE, // M4
};

export function profileFor(id: ChannelId): ChannelProfile {
  const p = PROFILES[id];
  if (!p) throw new Error(`Canal sin perfil configurado: ${id}`);
  return p;
}
