import { log } from '../log';

/**
 * Conversión APROXIMADA de dólares a las monedas de los países que atiende Carver.
 *
 * Nació de una conversación real: una clienta colombiana preguntó por "la beca de 2 millones de
 * pesos colombianos" y el bot le respondió solo en dólares. La persona piensa en su moneda.
 *
 * La regla que manda acá es la misma de toda la capa de precios: ante la duda, NO cotizar. Si las
 * tasas no se pudieron traer, o quedaron viejas, se devuelve null y el bot habla solo en dólares —
 * un equivalente con una tasa desactualizada es un número equivocado dicho a alguien que va a pagar.
 */

// Ecuador usa dólar, así que no necesita conversión.
const MONEDAS: Record<string, { pais: string; redondeo: number }> = {
  COP: { pais: 'Colombia', redondeo: 1000 },
  CLP: { pais: 'Chile', redondeo: 1000 },
  PEN: { pais: 'Perú', redondeo: 1 },
  DOP: { pais: 'República Dominicana', redondeo: 10 },
};

const TTL_MS = 12 * 60 * 60 * 1000;
const MAX_ANTIGUEDAD_MS = 4 * 24 * 60 * 60 * 1000; // pasado esto, mejor no convertir
let cache: { at: number; fecha: string; tasas: Record<string, number> } | null = null;
let enVuelo: Promise<void> | null = null;

async function refrescar(): Promise<void> {
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(8000) });
    const j: any = await r.json();
    if (j?.result !== 'success' || !j?.rates) throw new Error(`respuesta inesperada: ${j?.result}`);
    const tasas: Record<string, number> = {};
    for (const m of Object.keys(MONEDAS)) if (Number(j.rates[m]) > 0) tasas[m] = Number(j.rates[m]);
    cache = { at: Date.now(), fecha: String(j.time_last_update_utc ?? '').slice(5, 16), tasas };
    log.info('tipoCambio: tasas actualizadas', { fecha: cache.fecha, monedas: Object.keys(tasas).length });
  } catch (e) {
    log.warn('tipoCambio: no se pudieron traer las tasas', { err: String(e) });
  }
}

/** Dispara la actualización si hace falta. No bloquea: el turno en curso usa lo que haya. */
function asegurarTasas(): void {
  const vencido = !cache || Date.now() - cache.at > TTL_MS;
  if (vencido && !enVuelo) {
    enVuelo = refrescar().finally(() => {
      enVuelo = null;
    });
  }
}

/**
 * Equivalentes aproximados de varios montos en dólares. null si no hay tasas utilizables — el
 * llamador debe entonces hablar solo en dólares, no inventar una conversión.
 */
export function equivalencias(montosUsd: Record<string, number | undefined>): {
  fecha: string;
  nota: string;
  monedas: Record<string, Record<string, number>>;
} | null {
  asegurarTasas();
  if (!cache || Date.now() - cache.at > MAX_ANTIGUEDAD_MS) return null;
  if (!Object.keys(cache.tasas).length) return null;

  const monedas: Record<string, Record<string, number>> = {};
  for (const [moneda, cfg] of Object.entries(MONEDAS)) {
    const tasa = cache.tasas[moneda];
    if (!tasa) continue;
    const convertidos: Record<string, number> = {};
    for (const [clave, usd] of Object.entries(montosUsd)) {
      if (typeof usd !== 'number' || !(usd > 0)) continue;
      convertidos[clave] = Math.round((usd * tasa) / cfg.redondeo) * cfg.redondeo;
    }
    if (Object.keys(convertidos).length) monedas[moneda] = convertidos;
  }
  if (!Object.keys(monedas).length) return null;

  return {
    fecha: cache.fecha,
    nota:
      'APROXIMADOS, al tipo de cambio del día. Úsalos SOLO si la persona pregunta en su moneda o ' +
      'dice de qué país es. Di siempre que son aproximados y que el cobro se hace en DÓLARES, así ' +
      'que el monto final depende del tipo de cambio y de su banco. Nunca los presentes como el precio exacto.',
    monedas,
  };
}

/** Países que cubre cada moneda, para que el bot sepa cuál corresponde. */
export const PAIS_POR_MONEDA = Object.fromEntries(Object.entries(MONEDAS).map(([m, c]) => [m, c.pais]));
