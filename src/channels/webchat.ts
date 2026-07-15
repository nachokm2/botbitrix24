import { runAgentTurn, type ToolExecutor } from '../ai/agentLoop';
import { WEBCHAT_PROFILE } from '../core/channel';
import { consultarProgramas, detallePrograma } from '../core/catalogTool';
import { crearLeadWeb, actualizarDatosCliente, type DatosCliente } from '../crm/openlinesCrm';
import { generarBriefing } from '../ai/briefing';
import { getJson, setJson } from '../store/kv';
import { log } from '../log';
import type { AgentCtx } from '../ai/toolRunner';
import type { Auth } from '../store';

// M3 — Adaptador del canal WEB CHAT. Es la PRUEBA del patrón omnicanal: un canal nuevo = un PERFIL
// (core/channel.ts) + un ADAPTADOR (este archivo) + una estrategia de IDENTIDAD, reusando el MISMO
// motor (runAgentTurn/runConversation) y las tools de catálogo del núcleo. No duplica el motor.
//
// Identidad: cada visitante tiene un conversationId de navegador ("wc-...") que namespacea su memoria
// (Redis) y su lead. El leadId se crea perezosamente al capturar el primer dato y se cachea en la sesión.

export type WebchatSession = { leadId?: number };

const sessKey = (id: string) => `webchat:sess:${id}`;
const SESS_TTL = 24 * 3600;

export async function getWebchatSession(conversationId: string): Promise<WebchatSession> {
  return (await getJson<WebchatSession>(sessKey(conversationId))) ?? {};
}
async function saveWebchatSession(conversationId: string, s: WebchatSession): Promise<void> {
  await setJson(sessKey(conversationId), s, SESS_TTL);
}

/** Ejecutor de herramientas del canal web: catálogo al núcleo; captura/escala crean o actualizan un lead. */
function webchatExecutor(conversationId: string, auth: Auth, session: WebchatSession): ToolExecutor {
  const ensureLead = async (data: DatosCliente): Promise<number | null> => {
    if (session.leadId) return session.leadId;
    const id = await crearLeadWeb(data, auth);
    if (id) {
      session.leadId = id;
      await saveWebchatSession(conversationId, session);
    }
    return id;
  };

  return async (name, input) => {
    switch (name) {
      case 'consultar_programas':
        return consultarProgramas(input, WEBCHAT_PROFILE.catalog.consultar);

      case 'detalle_programa':
        return detallePrograma(input, WEBCHAT_PROFILE.catalog.detalle);

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
        log.info('webchat escalar_a_humano', { conversationId, leadId, motivo: input?.motivo });
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

/** Procesa un turno del chat web: mismo motor que WhatsApp, con el perfil y el ejecutor web. */
export async function webchatTurn(conversationId: string, message: string, auth: Auth): Promise<string> {
  const session = await getWebchatSession(conversationId);
  const ctx: AgentCtx = {
    auth,
    dialogId: conversationId, // namespacea la memoria (Redis) por visitante
    botId: 0, // el canal web no usa el bot de Open Lines
    crmEntities: session.leadId ? { lead: session.leadId } : {},
    crmEntity: session.leadId ? { type: 'lead', id: session.leadId } : null,
    profile: WEBCHAT_PROFILE,
  };
  return runAgentTurn(ctx, message, '', webchatExecutor(conversationId, auth, session));
}
