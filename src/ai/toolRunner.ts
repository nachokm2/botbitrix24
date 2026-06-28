import { callBitrix } from '../bitrix/client';
import { buscarProgramas } from './catalog';
import { getDetalle } from './detalles';
import { log } from '../log';
import type { Auth } from '../store';

export type AgentCtx = {
  auth: Auth;
  dialogId: string;
  chatId?: string | number;
  botId: number;
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

      case 'crear_lead_crm': {
        const fields: any = {
          TITLE: `Interesado postgrado: ${input.nombre}${input.programa_interes ? ' - ' + input.programa_interes : ''}`,
          NAME: input.nombre,
          SOURCE_ID: 'WEBFORM',
          COMMENTS: [
            input.programa_interes ? `Programa de interés: ${input.programa_interes}` : '',
            input.comentario ?? '',
            '[Generado por Agente IA - PoC]',
          ]
            .filter(Boolean)
            .join(' | '),
        };
        if (input.telefono) fields.PHONE = [{ VALUE: String(input.telefono), VALUE_TYPE: 'WORK' }];
        if (input.email) fields.EMAIL = [{ VALUE: String(input.email), VALUE_TYPE: 'WORK' }];

        const leadId = await callBitrix('crm.lead.add', { fields }, ctx.auth);
        log.info('tool crear_lead_crm', { leadId });
        return { ok: true, leadId };
      }

      case 'escalar_a_humano': {
        if (ctx.chatId) {
          await callBitrix('imopenlines.bot.session.operator', { CHAT_ID: ctx.chatId }, ctx.auth);
        }
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
