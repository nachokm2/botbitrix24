import { callCrm } from '../bitrix/client';
import { getRedisClient } from '../store/kv';
import { dbUltimaDerivacion } from '../store/db';
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

/** Cuándo movió el bot esta negociación a "Derivados Bot". Sirve para distinguir un movimiento
 *  posterior hecho por una persona del que hizo el propio bot. */
const MOVIDA_KEY = (dealId: number) => `etapa:derivado:${dealId}`;
const MOVIDA_TTL_SEG = 60 * 24 * 3600;

/**
 * ¿Un asesor ya trabajó esta derivación?
 *
 * El caso real: el bot deriva, el asesor toma la negociación y la mueve a "Contactando", y un rato
 * después vence el barrido por silencio —programado ANTES de que el asesor la tomara— y la devuelve
 * a "Derivados Bot" sin que el cliente haya escrito nada. Al asesor se le deshace el trabajo en
 * silencio y la negociación reaparece donde ya no corresponde.
 *
 * El barrido solo miraba `humanTookOver`, que se marca cuando alguien escribe EN EL CHAT. Un asesor
 * que trabaja el lead en el CRM —mueve la etapa, llama, manda un correo— nunca lo marca. Acá se mira
 * el CRM: si la etapa cambió DESPUÉS de que el bot la movió, y la movió una persona, ya se gestionó.
 *
 * Ante la duda —sin Redis, sin marca previa, Bitrix sin responder— devuelve false y todo sigue como
 * antes: es mejor una derivación de más que perder un caso que nadie tomó.
 */
export async function derivacionYaGestionada(dealId: number, auth: Auth): Promise<boolean> {
  const r = getRedisClient();
  if (!r || !dealId) return false;
  try {
    // La marca en Redis solo cubre lo movido desde que existe este resguardo; para lo anterior se
    // mira el registro de derivaciones, que sí tiene historial. Sin ninguna de las dos, el bot nunca
    // derivó esta negociación: es la primera vez y sí corresponde moverla.
    const marca = Number(await r.get(MOVIDA_KEY(dealId))) || (await dbUltimaDerivacion(dealId)) || 0;
    if (!marca) return false;
    const d: any = await callCrm('crm.deal.get', { id: dealId, select: ['MOVED_BY_ID', 'MOVED_TIME'] }, auth);
    const cuando = d?.MOVED_TIME ? new Date(d.MOVED_TIME).getTime() : 0;
    if (!cuando || cuando <= marca) return false; // nadie la movió después del bot
    const quien = Number(d?.MOVED_BY_ID ?? 0);
    if (!quien) return false;
    // El barrido automático a Remarketing no es gestión de nadie.
    if (config.usuariosAutomaticos.includes(quien)) return false;
    log.info('derivación ya gestionada por una persona: el bot no la mueve de vuelta', { dealId, quien, cuando: d.MOVED_TIME });
    return true;
  } catch (e) {
    log.warn('derivacionYaGestionada: no se pudo comprobar', { err: String(e), dealId });
    return false;
  }
}

/**
 * Mueve la negociación a la etapa de "derivadas" de SU embudo, si está configurada.
 *
 * Tres resguardos. No se toca una negociación que un asesor YA movió después de una derivación
 * anterior: devolverla a "Derivados Bot" le deshace el trabajo sin avisarle. No se toca una
 * negociación ya cerrada —ganada o perdida—: moverla borraría el desenlace y ensuciaría los informes
 * de cierre. Y la etapa tiene que ser del mismo embudo que la negociación: Bitrix rechaza una etapa
 * de otro embudo, y si la aceptara sería peor, porque sacaría el caso de su proceso.
 */
export async function moverAEtapaDerivado(dealId: number, auth: Auth): Promise<boolean> {
  if (!Object.keys(config.stageDerivado).length) return false;
  // Si un asesor ya la movió tras una derivación anterior, el caso está gestionado: devolverlo a
  // "Derivados Bot" le deshace el trabajo y nadie se entera.
  if (await derivacionYaGestionada(dealId, auth)) return false;
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
    // Etapas de matrícula en curso (firma/pago/validación): no están cerradas pero mover el caso a
    // "Derivados Bot" borra un avance real del asesor. Se dejan donde están.
    if (config.stageProtegidasDerivacion.includes(actual)) {
      log.info('no se mueve de etapa: la negociación está en una etapa protegida', { dealId, actual });
      return false;
    }
    await callCrm('crm.deal.update', { id: dealId, fields: { STAGE_ID: destino } }, auth);
    // Se deja la marca DESPUÉS del movimiento, para que quede por encima del MOVED_TIME que acaba de
    // escribir Bitrix por este mismo cambio: así el propio movimiento del bot no se confunde después
    // con la gestión de un asesor.
    await getRedisClient()
      ?.set(MOVIDA_KEY(dealId), String(Date.now()), 'EX', MOVIDA_TTL_SEG)
      .catch(() => {});
    log.info('negociación movida a la etapa de derivadas', { dealId, de: actual, a: destino });
    return true;
  } catch (e) {
    log.warn('moverAEtapaDerivado falló', { err: String(e), dealId });
    return false;
  }
}
