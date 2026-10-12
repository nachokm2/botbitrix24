import { callBitrix, callCrm } from '../bitrix/client';
import { config } from '../config';
import { marca } from '../marca';
import { audit } from '../obs/audit';
import type { CrmEntities } from '../crm/entities';
import type { Auth } from '../store';
import { log } from '../log';

/**
 * Modo copiloto: el bot redacta, la persona envía.
 *
 * Ataca por el otro lado el problema que dejó el piloto: de 38 casos derivados, 4 los trabajó
 * alguien. La respuesta obvia era insistirle al asesor para que tomara el caso — eso ya está hecho
 * (crm/vigilanciaDerivaciones.ts). Esta es la contraria: en vez de pedirle trabajo, entregárselo
 * medio hecho.
 *
 * Sirve además donde la automatización completa no es aceptable: un embudo de alto valor, un
 * programa con condiciones delicadas, o simplemente un equipo que todavía no confía en el bot.
 * El cliente nunca recibe nada automático; recibe lo que su asesor decidió enviarle.
 *
 * Decisión importante: en este modo el bot NO escribe en el chat. Si fallara y escribiera igual,
 * el cliente recibiría dos respuestas —la del bot y la del asesor— y el modo perdería todo sentido.
 */

export type ResultadoCopiloto = { entregado: boolean; destino?: number; motivo?: string };

/** ¿Esta conversación se atiende en modo copiloto? */
export function enModoCopiloto(crmEntities?: CrmEntities | null): boolean {
  if (!config.copilotoActivo) return false;
  // Sin embudos configurados, el modo aplica a todo. Con embudos, solo a esos.
  if (!config.copilotoCategorias.length) return true;
  return Boolean(crmEntities?.deal); // el filtro por embudo se resuelve al conocer el deal
}

/** Resuelve el embudo del deal para decidir si corresponde el modo copiloto. */
export async function aplicaCopiloto(crmEntities: CrmEntities | null | undefined, auth: Auth): Promise<boolean> {
  if (!config.copilotoActivo) return false;
  if (!config.copilotoCategorias.length) return true;
  const dealId = crmEntities?.deal;
  if (!dealId) return false; // con filtro por embudo, una conversación sin negociación no entra
  try {
    const d: any = await callCrm('crm.deal.get', { id: dealId, select: ['CATEGORY_ID'] }, auth);
    return config.copilotoCategorias.includes(Number(d?.CATEGORY_ID ?? -1));
  } catch (e) {
    log.warn('copiloto: no se pudo leer el embudo; se responde normal', { err: String(e), dealId });
    return false; // ante la duda, el comportamiento de siempre: el cliente recibe respuesta
  }
}

/**
 * Entrega el borrador al asesor en vez de enviarlo al cliente.
 * Devuelve `entregado: false` si no se pudo avisar a nadie — quien llama debe decidir qué hacer.
 */
export async function entregarBorrador(opts: {
  respuesta: string;
  mensajeCliente: string;
  dialogId: string;
  crmEntities?: CrmEntities | null;
  auth: Auth;
}): Promise<ResultadoCopiloto> {
  const dealId = opts.crmEntities?.deal;
  let destino = config.copilotoDestino;
  if (!destino && dealId) {
    try {
      const d: any = await callCrm('crm.deal.get', { id: dealId, select: ['ASSIGNED_BY_ID'] }, opts.auth);
      destino = Number(d?.ASSIGNED_BY_ID ?? 0);
    } catch (e) {
      log.warn('copiloto: no se pudo leer el responsable', { err: String(e), dealId });
    }
  }
  if (!destino) return { entregado: false, motivo: 'sin_destinatario' };

  const url = dealId ? `https://${opts.auth.domain}/crm/deal/details/${dealId}/` : '';
  const texto =
    `[B]Borrador de respuesta — ${marca.etiquetaPanel}[/B]\n` +
    (url ? `Negociación: [URL=${url}]#${dealId}[/URL]\n` : '') +
    `\n[B]El cliente escribió:[/B]\n${recorte(opts.mensajeCliente, 400)}\n` +
    `\n[B]Respuesta sugerida:[/B]\n${recorte(opts.respuesta, 1500)}\n` +
    '\nRevísala y envíala tú desde el chat. El asistente no le escribió nada al cliente.';

  try {
    await callBitrix('im.notify.personal.add', { USER_ID: destino, MESSAGE: texto }, opts.auth);
  } catch (e) {
    log.error('copiloto: no se pudo entregar el borrador', { err: String(e), destino, dialogId: opts.dialogId });
    return { entregado: false, motivo: 'fallo_envio' };
  }
  await audit({
    type: 'copiloto_borrador',
    dialogId: opts.dialogId,
    crmEntity: dealId ? `deal#${dealId}` : undefined,
    detail: { destino, largo: opts.respuesta.length },
  });
  log.info('copiloto: borrador entregado al asesor', { destino, dialogId: opts.dialogId });
  return { entregado: true, destino };
}

const recorte = (s: string, max: number) => (s.length > max ? s.slice(0, max) + '…' : s);
