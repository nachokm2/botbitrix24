import { runAgentTurn, type ToolExecutor } from '../ai/agentLoop';
import { consultarProgramas, detallePrograma } from '../core/catalogTool';
import { buscarCondiciones } from '../core/condicionesComerciales';
import type { ChannelProfile, AgentContext } from '../core/channel';
import { actualizarDatosCliente, obtenerContextoLlamada, type DatosCliente } from '../crm/crmWrite';
import { generarBriefing } from '../ai/briefing';
import { iniciarLlamadaSaliente } from '../voice/outbound';
import { getJson, setJson, once } from '../store/kv';
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

      case 'consultar_condiciones_comerciales':
        return buscarCondiciones(input?.programa, input?.sede);

      case 'registrar_interes_crm': {
        const data = (input ?? {}) as DatosCliente;
        if (!session.leadId) {
          const id = await ensureLead(data);
          return id ? { ok: true, actualizado: [`lead#${id}`] } : { ok: false, error: 'NO_LEAD' };
        }
        const r = await actualizarDatosCliente({ lead: session.leadId }, undefined, data, auth);
        return r.ok ? { ok: true, actualizado: r.actualizado } : { ok: false, error: r.error };
      }

      case 'solicitar_llamada': {
        const raw = String(input?.telefono ?? '').replace(/[\s()\-.]/g, '');
        // Normaliza a E.164 chileno y valida (+569XXXXXXXX). Evita marcar a números arbitrarios/premium.
        const telefono = raw.startsWith('+') ? raw : raw.startsWith('56') ? `+${raw}` : `+56${raw.replace(/^0+/, '')}`;
        if (!/^\+569\d{8}$/.test(telefono)) {
          return {
            ok: false,
            error: 'TELEFONO_INVALIDO',
            mensaje: 'Número inválido; confirma un móvil chileno (+56 9 ...) u ofrece derivar a un asesor.',
          };
        }
        // Rate-limit: máximo una llamada solicitada por conversación/hora (evita abuso y coste).
        if (!(await once(`call:${conversationId}`, 3600))) {
          return {
            ok: false,
            error: 'LIMITE_LLAMADAS',
            mensaje: 'Ya se solicitó una llamada hace poco; ofrece que un asesor lo contacte.',
          };
        }
        const leadId = await ensureLead({ telefono, ...(input?.nombre ? { nombre: input.nombre } : {}) });
        if (!leadId) return { ok: false, error: 'NO_LEAD', mensaje: 'No se pudo registrar el contacto; ofrece derivar con escalar_a_humano.' };
        // Guarda/actualiza el teléfono (best-effort) y arma el contexto (nombre/programa) para el
        // saludo inicial de la llamada, igual que en WhatsApp (ver toolRunner.ts).
        void actualizarDatosCliente({ lead: leadId }, undefined, { telefono }, auth).catch(() => {});
        const contexto = await obtenerContextoLlamada({ lead: leadId }, auth).catch(() => ({}));
        const r = await iniciarLlamadaSaliente(telefono, contexto, undefined, { metadata: { leadId } });
        if (!r.ok) {
          log.warn(`${channel.label} solicitar_llamada falló`, { err: r.error });
          return {
            ok: false,
            error: r.error,
            mensaje: 'No se pudo iniciar la llamada ahora. Ofrece que un asesor lo contacte en su lugar.',
          };
        }
        log.info(`${channel.label} solicitar_llamada`, { telefono, callId: r.callId });
        return {
          ok: true,
          llamando: true,
          mensaje: 'Llamada iniciada. Dile al cliente que recibirá la llamada en unos momentos.',
        };
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
