import { callBitrix } from '../bitrix/client';
import { buscarProgramas } from './catalog';
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
        const programas = buscarProgramas(input ?? {});
        return { ok: true, total: programas.length, programas };
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
