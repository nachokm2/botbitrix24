import { callCrm } from '../bitrix/client';
import { config } from '../config';
import { log } from '../log';
import type { Auth } from '../store';
import type { CrmEntities } from './entities';

/**
 * Asesores que atienden sus negociaciones sin el bot (ASESORES_SIN_BOT). Si el responsable de la
 * conversación es uno de ellos, el bot no le escribe a ese cliente por ninguna vía: ni responde, ni
 * manda recordatorios, ni primer contacto, ni reactivación.
 *
 * El responsable se lee en cada consulta, sin caché: reasignar la negociación en Bitrix tiene que
 * regir en el mensaje siguiente, en los dos sentidos.
 */

export function esAsesorSinBot(asesorId: unknown): boolean {
  return config.asesoresSinBot.includes(Number(asesorId ?? 0));
}

/**
 * El asesor sin bot a cargo de esta conversación, o null si no hay ninguno. Mira la negociación, y sin
 * negociación el lead o el contacto: el mismo orden con que el bot elige a qué asesor representar
 * (crm/directory.ts:getIdentidadAsesor). Una negociación de otro embudo no presta su responsable.
 *
 * Si Bitrix no responde, devuelve null y el bot atiende. Callar ante la duda dejaría sin respuesta a
 * todos los clientes mientras dure la falla (el webhook estuvo bloqueado por sobrecarga el 30-10-2026),
 * para cuidar a los de un solo asesor.
 */
export async function asesorSinBotACargo(entidades: CrmEntities | null | undefined, auth: Auth): Promise<number | null> {
  if (!config.asesoresSinBot.length) return null; // sin la variable no se consulta nada
  const metodo = entidades?.deal
    ? (['crm.deal.get', entidades.deal] as const)
    : entidades?.lead
      ? (['crm.lead.get', entidades.lead] as const)
      : entidades?.contact
        ? (['crm.contact.get', entidades.contact] as const)
        : null;
  if (!metodo) return null;
  try {
    const r = await callCrm<any>(metodo[0], { id: metodo[1] }, auth);
    const embudoAjeno =
      metodo[0] === 'crm.deal.get' && config.embudosPropios.length > 0 && !config.embudosPropios.includes(Number(r?.CATEGORY_ID ?? -1));
    if (embudoAjeno) return null;
    const asignado = Number(r?.ASSIGNED_BY_ID ?? r?.assignedById ?? 0);
    return esAsesorSinBot(asignado) ? asignado : null;
  } catch (e) {
    log.warn('asesorSinBotACargo: no se pudo leer el responsable; el bot atiende', { err: String(e), entidad: `${metodo[0]}#${metodo[1]}` });
    return null;
  }
}
