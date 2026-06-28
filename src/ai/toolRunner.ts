import { buscarProgramas } from './catalog';
import { getDetalle } from './detalles';
import { actualizarDatosCliente, type CrmEntity, type CrmEntities } from '../crm/openlinesCrm';
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
        log.info('tool escalar_a_humano', { motivo: input?.motivo, chatId: ctx.chatId });
        return { ok: true, escalado: true };
      }

      default:
        return { ok: false, error: 'UNKNOWN_TOOL' };
    }
  } catch (e) {
    log.error('tool error', { name, err: String(e) });
    return { ok: false, error: String(e) };
  }
}
