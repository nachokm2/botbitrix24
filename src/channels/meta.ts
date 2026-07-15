import { runAgentTurn, type ToolExecutor } from '../ai/agentLoop';
import { INSTAGRAM_PROFILE, MESSENGER_PROFILE } from '../core/channel';
import { consultarProgramas, detallePrograma } from '../core/catalogTool';
import { crearLeadSocial, actualizarDatosCliente, type DatosCliente } from '../crm/openlinesCrm';
import { generarBriefing } from '../ai/briefing';
import { getJson, setJson } from '../store/kv';
import { log } from '../log';
import type { AgentCtx } from '../ai/toolRunner';
import type { Auth } from '../store';

// M4 — Adaptador de los canales INSTAGRAM y MESSENGER (Meta Graph API). Mismo patrón que Web Chat
// (M3): un canal nuevo = un PERFIL (core/channel.ts) + un ADAPTADOR (este archivo) + una estrategia
// de IDENTIDAD, reusando el MISMO motor (runAgentTurn) y las tools de catálogo del núcleo.
//
// Identidad: cada usuario tiene un PSID (Page-Scoped ID) que Meta asigna por página/cuenta IG. El
// adaptador namespacea el conversationId con el prefijo del canal ("ig-"/"msgr-") — Instagram y
// Messenger usan espacios de PSID distintos igualmente, pero el prefijo deja la memoria (Redis) y
// el lead namespaced de forma explícita, igual que "wc-" en Web Chat. El leadId se crea perezosamente
// al capturar el primer dato y se cachea en la sesión.

export type MetaChannel = 'instagram' | 'messenger';
export type MetaSession = { leadId?: number };

const sessKey = (id: string) => `meta:sess:${id}`;
const SESS_TTL = 30 * 24 * 3600; // 30 días: el DM de una red social suele retomarse días después

export async function getMetaSession(conversationId: string): Promise<MetaSession> {
  return (await getJson<MetaSession>(sessKey(conversationId))) ?? {};
}
async function saveMetaSession(conversationId: string, s: MetaSession): Promise<void> {
  await setJson(sessKey(conversationId), s, SESS_TTL);
}

/** Namespacea el PSID por canal: evita que un mismo id numérico choque entre Instagram y Messenger. */
export function metaConversationId(canal: MetaChannel, psid: string): string {
  return `${canal === 'instagram' ? 'ig' : 'msgr'}-${psid}`;
}

/** Ejecutor de herramientas del canal Meta: catálogo al núcleo; captura/escala crean o actualizan un lead. */
function metaExecutor(conversationId: string, auth: Auth, session: MetaSession, canal: MetaChannel, profile: typeof INSTAGRAM_PROFILE): ToolExecutor {
  const ensureLead = async (data: DatosCliente): Promise<number | null> => {
    if (session.leadId) return session.leadId;
    const id = await crearLeadSocial(data, auth, canal);
    if (id) {
      session.leadId = id;
      await saveMetaSession(conversationId, session);
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
        log.info('meta escalar_a_humano', { conversationId, canal, leadId, motivo: input?.motivo });
        return {
          ok: true,
          escalado: true,
          mensaje: 'Perfecto, un asesor te contactará a la brevedad. ¿Hay algo más en lo que pueda ayudarte mientras tanto?',
        };
      }

      default:
        return { ok: false, error: 'UNKNOWN_TOOL' };
    }
  };
}

/** Procesa un turno de Instagram/Messenger: mismo motor que WhatsApp/Web Chat, con el perfil y ejecutor de Meta. */
export async function metaTurn(psid: string, message: string, auth: Auth, canal: MetaChannel): Promise<string> {
  const conversationId = metaConversationId(canal, psid);
  const profile = canal === 'instagram' ? INSTAGRAM_PROFILE : MESSENGER_PROFILE;
  const session = await getMetaSession(conversationId);
  const ctx: AgentCtx = {
    auth,
    dialogId: conversationId, // namespacea la memoria (Redis) por usuario+canal
    botId: 0, // los canales Meta no usan el bot de Open Lines
    crmEntities: session.leadId ? { lead: session.leadId } : {},
    crmEntity: session.leadId ? { type: 'lead', id: session.leadId } : null,
    profile,
  };
  return runAgentTurn(ctx, message, '', metaExecutor(conversationId, auth, session, canal, profile));
}
