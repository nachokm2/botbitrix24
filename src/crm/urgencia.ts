import { callCrm } from '../bitrix/client';
import { getRedisClient } from '../store/kv';
import { config } from '../config';
import { audit } from '../obs/audit';
import type { Auth } from '../store';
import { log } from '../log';

/**
 * Marca de urgencia en las negociaciones que el bot escala por puntaje alto.
 *
 * El escalamiento por score es el que más vale la pena atender rápido: lo dispara una conversación
 * donde la persona mostró interés claro, dio sus datos y hay intención de matricularse. Pero en el
 * embudo se ve igual que cualquier otra, así que el asesor no tiene cómo saber cuál mirar primero.
 *
 * Se marca en tres lugares, porque cada uno se mira en un momento distinto:
 *   - el TÍTULO, que es lo que se lee de un vistazo en la lista y en el kanban;
 *   - la TAREA de seguimiento, que es lo que le llega al asesor a su bandeja;
 *   - la auditoría, para poder medir después si atender primero lo urgente cambia algo.
 *
 * La marca vive además en Redis porque el bot reescribe el título cada vez que cambia el programa
 * de interés: sin eso, la urgencia se borraba sola en la siguiente actualización de datos.
 */

const CLAVE = (dealId: number) => `urgente:deal:${dealId}`;
const TTL_SEG = 60 * 24 * 3600; // la urgencia caduca: un lead de hace dos meses ya no es urgente

/** ¿Está marcada como urgente? Sin Redis responde que no: es preferible perder la marca a inventarla. */
export async function esUrgente(dealId?: number): Promise<boolean> {
  if (!dealId || !config.marcaUrgente) return false;
  const r = getRedisClient();
  if (!r) return false;
  try {
    return Boolean(await r.get(CLAVE(dealId)));
  } catch {
    return false;
  }
}

/** Antepone la marca al título, sin duplicarla si ya está. */
export function conMarcaUrgente(titulo: string): string {
  const marca = config.marcaUrgente;
  if (!marca) return titulo;
  return titulo.startsWith(marca) ? titulo : `${marca}${titulo}`;
}

/** Quita la marca, para poder recomponer un título sin arrastrarla por error. */
export function sinMarcaUrgente(titulo: string): string {
  const marca = config.marcaUrgente;
  return marca && titulo.startsWith(marca) ? titulo.slice(marca.length) : titulo;
}

/**
 * Marca la negociación como urgente: deja la marca en Redis y antepone el distintivo al título.
 * Idempotente — volver a llamarla con la misma negociación no duplica el prefijo ni reescribe.
 */
export async function marcarUrgente(dealId: number | undefined, auth: Auth, detalle: Record<string, unknown> = {}): Promise<boolean> {
  if (!dealId || !config.marcaUrgente) return false;
  const r = getRedisClient();
  try {
    if (r) await r.set(CLAVE(dealId), '1', 'EX', TTL_SEG);
    const d: any = await callCrm('crm.deal.get', { id: dealId, select: ['TITLE'] }, auth);
    const actual = String(d?.TITLE ?? '');
    const nuevo = conMarcaUrgente(actual);
    if (nuevo === actual) return false; // ya estaba marcada: no se reescribe
    await callCrm('crm.deal.update', { id: dealId, fields: { TITLE: nuevo } }, auth);
    await audit({ type: 'marcada_urgente', crmEntity: `deal#${dealId}`, detail: detalle });
    log.info('negociación marcada como urgente', { dealId, ...detalle });
    return true;
  } catch (e) {
    // No bloquea la derivación: que el asesor reciba el caso importa más que el distintivo.
    log.warn('marcarUrgente falló', { err: String(e), dealId });
    return false;
  }
}
