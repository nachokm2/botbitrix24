import { runAgentTurn, type ToolExecutor } from '../ai/agentLoop';
import { consultarProgramas, detallePrograma } from '../core/catalogTool';
import { buscarCondiciones } from '../core/condicionesComerciales';
import type { ChannelProfile, AgentContext } from '../core/channel';
import {
  actualizarDatosCliente,
  crearLeadDesde,
  crearNegociacionDesde,
  obtenerContextoLlamada,
  type DatosCliente,
  type LeadFuente,
} from '../crm/crmWrite';
import { buscarCrmPorTelefono } from '../crm/voiceActions';
import { guardarVinculoChat, loadPriorContext } from '../crm/chat';
import { getHistory } from '../ai/memory';
import type { CrmEntities } from '../crm/entities';
import { primaryEntity } from '../crm/entities';
import { generarBriefing } from '../ai/briefing';
import { iniciarLlamadaSaliente } from '../voice/outbound';
import { getJson, setJson, once } from '../store/kv';
import { audit } from '../obs/audit';
import { log } from '../log';
import type { Auth } from '../store';

// Ejecutor COMPARTIDO para los canales de texto cuya identidad es "sesión de conversación +
// negociación creada perezosamente" — hoy Web Chat, Instagram y Messenger (ver ALT-Alta-1 de la
// auditoría: antes de esto, webchatExecutor/metaExecutor eran casi una copia literal el uno
// del otro). WhatsApp (Open Lines) y Voz quedan FUERA a propósito: resuelven la identidad de
// forma distinta (chatId de Bitrix / búsqueda por teléfono) y ya tienen su propia lógica
// (más rica: transferencia a operador, nombrar al asesor) en toolRunner.ts y voice/vapiTools.ts.
//
// Entidad CRM: mientras no se conoce el teléfono, se mantiene un LEAD temporal (para no perder lo
// ya capturado). En cuanto llega el teléfono, se busca en el CRM (buscarCrmPorTelefono, igual que
// voz) ANTES de seguir escribiendo en el lead: si la persona ya existe, se reutiliza y migra ahí lo
// capturado (mismo mecanismo que WhatsApp — ver crmWrite.ts:migrarSiCambioDeEntidad, disparado por
// actualizarDatosCliente al pasarle chatId=conversationId); si no existe, se crea la NEGOCIACIÓN
// directo (Contacto + Deal) en el embudo de Asignación que corresponde — sin Lead intermedio.

export type LeadSession = { entities?: CrmEntities; programaInteres?: string };

/** Declara CÓMO se identifica y persiste un canal de este tipo, sin duplicar el ejecutor. */
export type SocialTextChannel = {
  /** Namespace de la clave de sesión en Redis (p. ej. "webchat", "meta"). */
  namespace: string;
  /** TTL de la sesión (segundos). */
  sessionTtlSec: number;
  /** Cómo se etiqueta/titula el lead temporal o la negociación creados por este canal. */
  fuente: LeadFuente;
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

/** Ejecutor de herramientas: catálogo al núcleo; captura/escala crean, buscan o actualizan la entidad de la sesión. */
export function socialTextExecutor(
  channel: SocialTextChannel,
  conversationId: string,
  auth: Auth,
  session: LeadSession,
  profile: ChannelProfile,
): ToolExecutor {
  /** Resuelve qué entidad CRM usar para `data`. Ya hay negociación real (contacto/deal) → la reutiliza.
   *  Llega el teléfono por primera vez → busca en el CRM antes de crear nada; si existe, la usa
   *  (el llamador dispara la migración de datos vía actualizarDatosCliente); si no, crea la
   *  negociación directo. Sin teléfono aún → mantiene/crea el lead temporal. */
  const resolverEntidad = async (data: DatosCliente): Promise<CrmEntities | null> => {
    if (session.entities?.contact || session.entities?.deal) return session.entities;
    if (data.programa_interes) session.programaInteres = data.programa_interes;

    if (data.telefono) {
      const encontrado = await buscarCrmPorTelefono(data.telefono, auth);
      const destino =
        encontrado ??
        (await crearNegociacionDesde(
          { ...data, programa_interes: data.programa_interes ?? session.programaInteres },
          auth,
          channel.fuente,
        ));
      if (destino) {
        session.entities = destino;
        await saveLeadSession(channel, conversationId, session);
        return destino;
      }
      // si falla la búsqueda/creación, cae al lead temporal (existente o nuevo) como respaldo
    }

    if (session.entities?.lead) return session.entities;
    const leadId = await crearLeadDesde(data, auth, channel.fuente);
    if (!leadId) return null;
    session.entities = { lead: leadId };
    await saveLeadSession(channel, conversationId, session);
    await guardarVinculoChat(conversationId, { type: 'lead', id: leadId, programaInteres: session.programaInteres }).catch(
      (e) => log.warn('guardarVinculoChat (social) falló', { err: String(e) }),
    );
    return session.entities;
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
        const entities = await resolverEntidad(data);
        if (!entities) return { ok: false, error: 'NO_LEAD' };
        // chatId=conversationId: si `entities` cambió respecto al lead temporal previo (recién
        // resuelto por teléfono), dispara la migración de datos + asignación de embudo.
        const r = await actualizarDatosCliente(entities, conversationId, data, auth);
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
        const entities = await resolverEntidad({ telefono, ...(input?.nombre ? { nombre: input.nombre } : {}) });
        if (!entities) return { ok: false, error: 'NO_LEAD', mensaje: 'No se pudo registrar el contacto; ofrece derivar con escalar_a_humano.' };
        // Guarda/actualiza el teléfono (best-effort) y arma el contexto (nombre/programa) para el
        // saludo inicial de la llamada, igual que en WhatsApp (ver toolRunner.ts).
        void actualizarDatosCliente(entities, conversationId, { telefono }, auth).catch(() => {});
        const contexto = await obtenerContextoLlamada(entities, auth).catch(() => ({}));
        const r = await iniciarLlamadaSaliente(telefono, contexto, undefined, {
          metadata: { dealId: entities.deal, contactId: entities.contact, leadId: entities.lead },
        });
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
        const entities = await resolverEntidad((input ?? {}) as DatosCliente);
        const entity = entities ? primaryEntity(entities) : null;
        // Deja el resumen para el asesor (best-effort; no bloquea la respuesta).
        if (entity) void generarBriefing(conversationId, entity, auth);
        log.info(`${channel.label} escalar_a_humano`, { conversationId, entity, motivo: input?.motivo });
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

/** Procesa un turno de un canal "sesión + negociación perezosa": mismo motor que WhatsApp (runAgentTurn). */
export async function socialTextTurn(
  channel: SocialTextChannel,
  conversationId: string,
  message: string,
  auth: Auth,
  profile: ChannelProfile,
): Promise<string> {
  const session = await getLeadSession(channel, conversationId);
  const entity = session.entities ? primaryEntity(session.entities) : null;
  // Solo en el primer turno: si la sesión ya venía con una negociación real (encontrada por
  // teléfono — ver resolverEntidad más arriba), carga el programa/notas ya registrados en el CRM
  // para que el bot no vuelva a preguntar "¿qué programa te interesa?" de cero.
  const esNueva = (await getHistory(conversationId)).length === 0;
  const priorContext = esNueva && entity ? await loadPriorContext(entity, auth) : '';
  const ctx: AgentContext = {
    auth,
    conversationId,
    botId: 0, // estos canales no usan el bot de Open Lines
    crmEntities: session.entities ?? {},
    crmEntity: entity,
    profile,
  };
  const reply = await runAgentTurn(ctx, message, priorContext, socialTextExecutor(channel, conversationId, auth, session, profile));
  // Auditoría del turno (compliance + panel de métricas) — antes solo WhatsApp la registraba, así
  // que "Mensajes" en el panel no contaba nada de Web Chat/Instagram/Messenger (bug real: 8 de 12
  // conversaciones del día quedaban fuera del conteo).
  const entityDespues = session.entities ? primaryEntity(session.entities) : null;
  void audit({
    type: 'turn',
    dialogId: conversationId,
    crmEntity: entityDespues ? `${entityDespues.type}#${entityDespues.id}` : undefined,
    detail: { message, reply },
  });
  return reply;
}
