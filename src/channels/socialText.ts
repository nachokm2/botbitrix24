import { runAgentTurn, type ToolExecutor } from '../ai/agentLoop';
import { consultarProgramas, detallePrograma } from '../core/catalogTool';
import type { ChannelProfile, AgentContext } from '../core/channel';
import { actualizarDatosCliente, type DatosCliente } from '../crm/openlinesCrm';
import { generarBriefing } from '../ai/briefing';
import { getJson, setJson } from '../store/kv';
import { log } from '../log';
import type { Auth } from '../store';

// Ejecutor COMPARTIDO para los canales de texto cuya identidad es "sesión de conversación +
// lead creado perezosamente" — hoy Web Chat, Instagram y Messenger (ver ALT-Alta-1 de la
// auditoría: antes de esto, webchatExecutor/metaExecutor eran casi una copia literal el uno
// del otro). WhatsApp (Open Lines) y Voz quedan FUERA a propósito: resuelven la identidad de
// forma distinta (chatId de Bitrix / búsqueda por teléfono) y ya tienen su propia lógica
// (más rica: transferencia a operador, nombrar al asesor) en toolRunner.ts y voice/vapiTools.ts.

export type LeadSession = { leadId?: number };

/** Declara CÓMO se identifica y persiste un canal de este tipo, sin duplicar el ejecutor. */
export type SocialTextChannel = {
  /** Namespace de la clave de sesión en Redis (p. ej. "webchat", "meta"). */
  namespace: string;
  /** TTL de la sesión (segundos). */
  sessionTtlSec: number;
  /** Crea el lead en Bitrix24 cuando la sesión aún no tiene uno cacheado. */
  crearLead: (data: DatosCliente, auth: Auth) => Promise<number | null>;
  /** Etiqueta para logs (p. ej. "webchat", "instagram", "messenger"). */
  label: string;
};

const sessKey = (channel: SocialTextChannel, conversationId: string) => `${channel.namespace}:sess:${conversationId}`;

export async function getLeadSession(channel: SocialTextChannel, conversationId: string): Promise<LeadSession> {
  return (await getJson<LeadSession>(sessKey(channel, conversationId))) ?? {};
}
async function saveLeadSession(channel: SocialTextChannel, conversationId: string, s: LeadSession): Promise<void> {
  await setJson(sessKey(channel, conversationId), s, channel.sessionTtlSec);
}

/** Ejecutor de herramientas: catálogo al núcleo; captura/escala crean o actualizan el lead de la sesión. */
export function socialTextExecutor(
  channel: SocialTextChannel,
  conversationId: string,
  auth: Auth,
  session: LeadSession,
  profile: ChannelProfile,
): ToolExecutor {
  const ensureLead = async (data: DatosCliente): Promise<number | null> => {
    if (session.leadId) return session.leadId;
    const id = await channel.crearLead(data, auth);
    if (id) {
      session.leadId = id;
      await saveLeadSession(channel, conversationId, session);
    }
    return id;
  };

  return async (name, input) => {
    switch (name) {
      case 'consultar_programas':
        return consultarProgramas(input, profile.catalog.consultar);

      case 'detalle_programa':
        return detallePrograma(input, profile.catalog.detalle);

      case 'registrar_interes_crm': {
        const data = (input ?? {}) as DatosCliente;
        if (!session.leadId) {
          const id = await ensureLead(data);
          return id ? { ok: true, actualizado: [`lead#${id}`] } : { ok: false, error: 'NO_LEAD' };
        }
        const r = await actualizarDatosCliente({ lead: session.leadId }, undefined, data, auth);
        return r.ok ? { ok: true, actualizado: r.actualizado } : { ok: false, error: r.error };
      }

      case 'escalar_a_humano': {
        const leadId = await ensureLead((input ?? {}) as DatosCliente);
        // Deja el resumen del lead para el asesor (best-effort; no bloquea la respuesta).
        if (leadId) void generarBriefing(conversationId, { type: 'lead', id: leadId }, auth);
        log.info(`${channel.label} escalar_a_humano`, { conversationId, leadId, motivo: input?.motivo });
        return {
          ok: true,
          escalado: true,
          mensaje:
            'Perfecto, un asesor te contactará a la brevedad. ¿Hay algo más en lo que pueda ayudarte mientras tanto?',
        };
      }

      default:
        return { ok: false, error: 'UNKNOWN_TOOL' };
    }
  };
}

/** Procesa un turno de un canal "sesión + lead perezoso": mismo motor que WhatsApp (runAgentTurn). */
export async function socialTextTurn(
  channel: SocialTextChannel,
  conversationId: string,
  message: string,
  auth: Auth,
  profile: ChannelProfile,
): Promise<string> {
  const session = await getLeadSession(channel, conversationId);
  const ctx: AgentContext = {
    auth,
    conversationId,
    botId: 0, // estos canales no usan el bot de Open Lines
    crmEntities: session.leadId ? { lead: session.leadId } : {},
    crmEntity: session.leadId ? { type: 'lead', id: session.leadId } : null,
    profile,
  };
  return runAgentTurn(ctx, message, '', socialTextExecutor(channel, conversationId, auth, session, profile));
}
