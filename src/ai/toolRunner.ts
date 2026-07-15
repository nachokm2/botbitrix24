import { consultarProgramas, detallePrograma } from '../core/catalogTool';
import { WHATSAPP_PROFILE, type ChannelProfile } from '../core/channel';
import { actualizarDatosCliente, getDealAsesores, type CrmEntity, type CrmEntities } from '../crm/openlinesCrm';
import { generarBriefing } from './briefing';
import { iniciarLlamadaSaliente } from '../voice/outbound';
import { markHumanTakeover, getSession, saveSession } from '../session';
import { callBitrix } from '../bitrix/client';
import { once } from '../store/kv';
import { log } from '../log';
import type { Auth } from '../store';

export type AgentCtx = {
  auth: Auth;
  dialogId: string;
  chatId?: string | number;
  botId: number;
  crmEntity?: CrmEntity | null;
  crmEntities?: CrmEntities;
  /** Perfil del canal (tono/longitud/capacidades/presentación). Default: WhatsApp. */
  profile?: ChannelProfile;
};

export async function executeTool(name: string, input: any, ctx: AgentCtx): Promise<any> {
  const catalog = (ctx.profile ?? WHATSAPP_PROFILE).catalog;
  try {
    switch (name) {
      case 'consultar_programas':
        return consultarProgramas(input, catalog.consultar);

      case 'detalle_programa':
        return detallePrograma(input, catalog.detalle);

      case 'registrar_interes_crm': {
        const r = await actualizarDatosCliente(ctx.crmEntities ?? {}, ctx.chatId, input ?? {}, ctx.auth);
        if (!r.ok) return { ok: false, error: r.error };
        log.info('tool registrar_interes_crm', { actualizado: r.actualizado });
        return { ok: true, actualizado: r.actualizado };
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
        // Rate-limit: máximo una llamada solicitada por diálogo/hora (evita abuso y coste).
        if (!(await once(`call:${ctx.dialogId}`, 3600))) {
          return {
            ok: false,
            error: 'LIMITE_LLAMADAS',
            mensaje: 'Ya se solicitó una llamada hace poco; ofrece que un asesor lo contacte.',
          };
        }
        // Guarda/actualiza el teléfono en el CRM antes de llamar (best-effort, no bloquea).
        void actualizarDatosCliente(ctx.crmEntities ?? {}, ctx.chatId, { telefono }, ctx.auth).catch(() => {});
        const r = await iniciarLlamadaSaliente(telefono);
        if (!r.ok) {
          log.warn('tool solicitar_llamada falló', { err: r.error });
          return {
            ok: false,
            error: r.error,
            mensaje: 'No se pudo iniciar la llamada ahora. Ofrece que un asesor lo contacte en su lugar.',
          };
        }
        log.info('tool solicitar_llamada', { telefono, callId: r.callId });
        return {
          ok: true,
          llamando: true,
          mensaje: 'Llamada iniciada. Dile al cliente que recibirá la llamada de nuestra asistente en unos momentos.',
        };
      }

      case 'escalar_a_humano': {
        if (ctx.chatId) {
          await callBitrix('imopenlines.bot.session.operator', { CHAT_ID: ctx.chatId }, ctx.auth);
        }
        await markHumanTakeover(ctx.dialogId); // tras escalar, el bot deja de responder en esa sesión

        // Genera (una vez) un resumen del lead para el asesor y lo deja en el CRM.
        const entityBrief = ctx.crmEntity ?? null;
        if (entityBrief) {
          const s = await getSession(ctx.dialogId);
          if (!s.briefingDone) {
            s.briefingDone = true;
            await saveSession(ctx.dialogId, s);
            void generarBriefing(ctx.dialogId, entityBrief, ctx.auth);
          }
        }

        // Trae el asesor asignado (responsable del deal) para que el bot pueda nombrarlo al cliente.
        let asesor: string | null = null;
        if (ctx.crmEntities?.deal) {
          try {
            const { responsable } = await getDealAsesores(ctx.crmEntities.deal, ctx.auth);
            if (responsable && !responsable.nombre.startsWith('Usuario ')) asesor = responsable.nombre;
          } catch (e) {
            log.warn('escalar_a_humano: no se pudo traer el responsable', { err: String(e) });
          }
        }
        log.info('tool escalar_a_humano', { motivo: input?.motivo, chatId: ctx.chatId, asesor });
        return {
          ok: true,
          escalado: true,
          asesor,
          mensaje: asesor
            ? `Conversación derivada. Informa al cliente, de forma cálida, que su asesor asignado ${asesor} lo contactará a la brevedad.`
            : 'Conversación derivada a un asesor. Informa al cliente que un asesor lo contactará a la brevedad.',
        };
      }

      default:
        return { ok: false, error: 'UNKNOWN_TOOL' };
    }
  } catch (e) {
    log.error('tool error', { name, err: String(e) });
    return { ok: false, error: String(e) };
  }
}
