import { buscarProgramas } from './catalog';
import { getDetalle } from './detalles';
import { actualizarDatosCliente, getDealAsesores, type CrmEntity, type CrmEntities } from '../crm/openlinesCrm';
import { markHumanTakeover } from '../session';
import { callBitrix } from '../bitrix/client';
import { log } from '../log';
import type { Auth } from '../store';

export type AgentCtx = {
  auth: Auth;
  dialogId: string;
  chatId?: string | number;
  botId: number;
  crmEntity?: CrmEntity | null;
  crmEntities?: CrmEntities;
};

export async function executeTool(name: string, input: any, ctx: AgentCtx): Promise<any> {
  try {
    switch (name) {
      case 'consultar_programas': {
        const all = buscarProgramas(input ?? {});
        const LIMIT = 20;
        return {
          ok: true,
          total: all.length,
          mostrando: Math.min(all.length, LIMIT),
          programas: all.slice(0, LIMIT),
          nota: all.length > LIMIT ? 'Hay más resultados; pide al usuario que afine por facultad o tema.' : undefined,
        };
      }

      case 'detalle_programa': {
        const d = getDetalle({ url: input?.url, nombre: input?.nombre });
        if (!d) {
          return {
            ok: false,
            error: 'SIN_DETALLE',
            mensaje:
              'Aún no tengo el detalle cargado de ese programa. Comparte la URL oficial y ofrece derivar a un asesor.',
          };
        }
        return { ok: true, detalle: d };
      }

      case 'registrar_interes_crm': {
        const r = await actualizarDatosCliente(ctx.crmEntities ?? {}, ctx.chatId, input ?? {}, ctx.auth);
        if (!r.ok) return { ok: false, error: r.error };
        log.info('tool registrar_interes_crm', { actualizado: r.actualizado });
        return { ok: true, actualizado: r.actualizado };
      }

      case 'escalar_a_humano': {
        if (ctx.chatId) {
          await callBitrix('imopenlines.bot.session.operator', { CHAT_ID: ctx.chatId }, ctx.auth);
        }
        await markHumanTakeover(ctx.dialogId); // tras escalar, el bot deja de responder en esa sesión

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
