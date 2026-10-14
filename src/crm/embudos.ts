import { callCrm } from '../bitrix/client';
import { config } from '../config';
import type { Auth } from '../store';
import { log } from '../log';

/**
 * ¿Esta negociación es de un embudo de MI marca?
 *
 * Los dos bots comparten portal de Bitrix. Sin este límite, una conversación de Carver enlazada por
 * Bitrix a una negociación vieja de Postgrados terminaba renombrada con un programa de Carver y
 * reasignada al responsable de Carver: el lead salía del embudo y de las manos de su asesor.
 *
 * Sin `BITRIX_EMBUDOS_PROPIOS` configurado, todo es propio — así nada cambia donde no haga falta.
 */

const CACHE_MS = 5 * 60_000;
const cache = new Map<number, { propio: boolean; hasta: number }>();

export async function esEmbudoPropio(dealId: number | undefined, auth: Auth): Promise<boolean> {
  if (!config.embudosPropios.length) return true; // sin lista, el comportamiento de siempre
  if (!dealId) return false;
  const ahora = Date.now();
  const guardado = cache.get(dealId);
  if (guardado && guardado.hasta > ahora) return guardado.propio;
  try {
    const d: any = await callCrm('crm.deal.get', { id: dealId, select: ['CATEGORY_ID'] }, auth);
    const propio = config.embudosPropios.includes(Number(d?.CATEGORY_ID ?? -1));
    cache.set(dealId, { propio, hasta: ahora + CACHE_MS });
    if (!propio) log.info('negociación de otro embudo: el bot no la va a modificar', { dealId, categoria: d?.CATEGORY_ID });
    return propio;
  } catch (e) {
    // Si no se puede comprobar, se asume AJENA: no tocar lo que no se sabe de quién es.
    log.warn('esEmbudoPropio: no se pudo leer el embudo', { err: String(e), dealId });
    return false;
  }
}

/** Filtro de embudo para las consultas que buscan negociaciones del contacto. */
export function filtroEmbudosPropios(): Record<string, unknown> {
  return config.embudosPropios.length ? { '@CATEGORY_ID': config.embudosPropios } : {};
}

/**
 * Mueve la negociación a la etapa de "derivadas" de SU embudo, si está configurada.
 *
 * Dos resguardos. No se toca una negociación ya cerrada —ganada o perdida—: moverla a "Derivados
 * Bot" borraría el desenlace y ensuciaría los informes de cierre. Y la etapa tiene que ser del
 * mismo embudo que la negociación: Bitrix rechaza una etapa de otro embudo, y si la aceptara sería
 * peor, porque sacaría el caso de su proceso.
 */
export async function moverAEtapaDerivado(dealId: number, auth: Auth): Promise<boolean> {
  if (!Object.keys(config.stageDerivado).length) return false;
  try {
    const d: any = await callCrm('crm.deal.get', { id: dealId, select: ['CATEGORY_ID', 'STAGE_ID', 'CLOSED'] }, auth);
    const categoria = Number(d?.CATEGORY_ID ?? -1);
    const destino = config.stageDerivado[categoria];
    if (!destino) return false;
    const actual = String(d?.STAGE_ID ?? '');
    if (actual === destino) return false; // ya está ahí: reescribirlo solo ensucia el historial
    if (d?.CLOSED === 'Y' || /:(WON|LOSE)$/.test(actual)) {
      log.info('no se mueve de etapa: la negociación ya está cerrada', { dealId, actual });
      return false;
    }
    await callCrm('crm.deal.update', { id: dealId, fields: { STAGE_ID: destino } }, auth);
    log.info('negociación movida a la etapa de derivadas', { dealId, de: actual, a: destino });
    return true;
  } catch (e) {
    log.warn('moverAEtapaDerivado falló', { err: String(e), dealId });
    return false;
  }
}
