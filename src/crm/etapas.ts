import { callBitrix, callCrm } from '../bitrix/client';
import { config } from '../config';
import type { Auth } from '../store';
import { log } from '../log';

/**
 * Resguardos comunes para cualquier movimiento de etapa que haga el bot (auditoría BIT-01/02/03).
 *
 * Tres reglas que antes vivían —a medias— solo en algunos caminos:
 *  1. Una negociación cerrada (ganada o perdida) no se mueve nunca.
 *  2. El bot no retrocede una negociación: solo la mueve hacia una etapa POSTERIOR del mismo embudo,
 *     según el orden (SORT) que tiene en Bitrix. Así no se deshace lo que avanzó un asesor.
 *  3. El movimiento propio del bot no es "gestión humana": el usuario con que escribe el bot (dueño
 *     del webhook o usuario OAuth) se excluye igual que los robots de Bitrix.
 */

const ORDEN_TTL_MS = 30 * 60_000;
const ordenCache = new Map<number, { orden: Map<string, number>; hasta: number }>();

/** STATUS_ID → SORT de las etapas de un embudo. Vacío si no se pudo leer (no se cachea el fallo). */
export async function ordenDeEtapas(categoria: number, auth: Auth): Promise<Map<string, number>> {
  if (!Number.isFinite(categoria) || categoria < 0) return new Map();
  const ahora = Date.now();
  const guardado = ordenCache.get(categoria);
  if (guardado && guardado.hasta > ahora) return guardado.orden;
  try {
    const entityId = categoria === 0 ? 'DEAL_STAGE' : `DEAL_STAGE_${categoria}`;
    const r: any = await callCrm('crm.status.list', { filter: { ENTITY_ID: entityId } }, auth);
    const filas: any[] = Array.isArray(r) ? r : Array.isArray(r?.result) ? r.result : [];
    const orden = new Map<string, number>();
    for (const s of filas) {
      const sort = Number(s?.SORT);
      if (s?.STATUS_ID && Number.isFinite(sort)) orden.set(String(s.STATUS_ID), sort);
    }
    if (orden.size) ordenCache.set(categoria, { orden, hasta: ahora + ORDEN_TTL_MS });
    return orden;
  } catch (e) {
    log.warn('ordenDeEtapas: no se pudo leer el orden del embudo', { err: String(e), categoria });
    return new Map();
  }
}

/**
 * ¿Pasar de `de` a `a` es avanzar en el embudo? true = avanza, false = retrocede o se queda en el
 * mismo nivel, null = no se sabe (falta alguna de las dos etapas en el orden de Bitrix).
 */
export async function esAvance(categoria: number, de: string, a: string, auth: Auth): Promise<boolean | null> {
  const orden = await ordenDeEtapas(categoria, auth);
  const sDe = orden.get(de);
  const sA = orden.get(a);
  if (sDe === undefined || sA === undefined) return null;
  return sA > sDe;
}

export function estaCerrada(d: { CLOSED?: unknown; STAGE_ID?: unknown } | null | undefined): boolean {
  return d?.CLOSED === 'Y' || /:(WON|LOSE)$/.test(String(d?.STAGE_ID ?? '')) || /^(WON|LOSE)$/.test(String(d?.STAGE_ID ?? ''));
}

const BOT_TTL_MS = 60 * 60_000;
let botCache: { ids: Set<number>; hasta: number } | null = null;

/**
 * IDs de usuario con los que escribe el propio bot. Bitrix registra MOVED_BY_ID con el dueño de la
 * credencial, así que un movimiento del bot aparecía como si lo hubiera hecho una persona.
 * Configurable con BITRIX_USUARIOS_BOT; además se pregunta a Bitrix (user.current) por el webhook y
 * por el usuario OAuth.
 */
export async function usuariosDelBot(auth: Auth): Promise<Set<number>> {
  const ahora = Date.now();
  if (botCache && botCache.hasta > ahora) return botCache.ids;
  const ids = new Set<number>(config.usuariosBot);
  let consultado = false;
  try {
    const u: any = await callCrm('user.current', {}, auth);
    const id = Number(u?.ID ?? 0);
    if (id > 0) ids.add(id);
    consultado = true;
  } catch (e) {
    log.warn('usuariosDelBot: user.current (CRM) falló', { err: String(e) });
  }
  // Si el CRM va por webhook, el OAuth es otra identidad que también puede escribir (eventos, chat).
  if (config.bitrixWebhookUrl && auth?.access_token) {
    try {
      const u: any = await callBitrix('user.current', {}, auth);
      const id = Number(u?.ID ?? 0);
      if (id > 0) ids.add(id);
    } catch {
      /* el OAuth puede no estar disponible: basta con el webhook */
    }
  }
  if (consultado) botCache = { ids, hasta: ahora + BOT_TTL_MS };
  return ids;
}

/** ¿Este usuario es una automatización (robot de Bitrix o el propio bot) y no una persona? */
export async function esUsuarioAutomatico(userId: number, auth: Auth): Promise<boolean> {
  if (!userId) return true;
  if (config.usuariosAutomaticos.includes(userId)) return true;
  return (await usuariosDelBot(auth)).has(userId);
}

/**
 * ¿La etapa actual la puso una persona? Bitrix fija MOVED_TIME = DATE_CREATE al crear la negociación,
 * así que solo cuenta un movimiento posterior a la creación hecho por alguien que no sea automático.
 */
export async function etapaMovidaPorPersona(
  d: { MOVED_BY_ID?: unknown; MOVED_TIME?: unknown; DATE_CREATE?: unknown } | null | undefined,
  auth: Auth,
): Promise<boolean> {
  const movido = d?.MOVED_TIME ? new Date(String(d.MOVED_TIME)).getTime() : NaN;
  if (!Number.isFinite(movido)) return false;
  const creado = d?.DATE_CREATE ? new Date(String(d.DATE_CREATE)).getTime() : NaN;
  if (Number.isFinite(creado) && movido - creado < 60_000) return false; // etapa de creación
  return !(await esUsuarioAutomatico(Number(d?.MOVED_BY_ID ?? 0), auth));
}

/**
 * ¿Puede el scoring llevar esta negociación a `destino`? (auditoría BIT-03)
 *
 * El scoring decidía solo contra la última etapa que recordaba la sesión (6 h en memoria): retrocedía
 * de "Postulante" a "Interesado" si el puntaje bajaba unos puntos, y en una sesión nueva reabría
 * negociaciones ganadas o deshacía el avance de un asesor. Acá se mira la negociación REAL en Bitrix.
 * Si no se puede comprobar algo, no se mueve: un movimiento por puntaje que no se hace no rompe nada.
 */
export async function revisarMovimientoPorScore(
  dealId: number,
  destino: string,
  auth: Auth,
): Promise<{ mover: boolean; motivo: string; categoria?: number; actual?: string }> {
  try {
    const d: any = await callCrm(
      'crm.deal.get',
      { id: dealId, select: ['CATEGORY_ID', 'STAGE_ID', 'CLOSED', 'MOVED_BY_ID', 'MOVED_TIME', 'DATE_CREATE'] },
      auth,
    );
    const categoria = Number(d?.CATEGORY_ID ?? -1);
    const actual = String(d?.STAGE_ID ?? '');
    const base = { categoria, actual };
    if (!actual) return { ...base, mover: false, motivo: 'sin_etapa' };
    if (estaCerrada(d)) return { ...base, mover: false, motivo: 'cerrada' };
    const m = /^C(\d+):/.exec(destino);
    const categoriaDestino = m ? Number(m[1]) : 0;
    if (categoriaDestino !== categoria) return { ...base, mover: false, motivo: 'otro_embudo' };
    if (actual === destino) return { ...base, mover: false, motivo: 'ya_esta' };
    if (await etapaMovidaPorPersona(d, auth)) return { ...base, mover: false, motivo: 'movida_por_persona' };
    const avance = await esAvance(categoria, actual, destino, auth);
    if (avance === null) return { ...base, mover: false, motivo: 'orden_desconocido' };
    if (!avance) return { ...base, mover: false, motivo: 'retroceso' };
    return { ...base, mover: true, motivo: 'avance' };
  } catch (e) {
    log.warn('revisarMovimientoPorScore: no se pudo leer la negociación', { err: String(e), dealId });
    return { mover: false, motivo: 'error_lectura' };
  }
}

/** Solo para tests. */
export function _resetEtapasCache(): void {
  ordenCache.clear();
  botCache = null;
}
