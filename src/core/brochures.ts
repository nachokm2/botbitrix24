import { getDetalle } from '../ai/detalles';
import { PROGRAMAS } from '../ai/catalog';
import { esTipoComercializable } from './oferta';
import { log } from '../log';

/**
 * Brochure de un programa, VERIFICADO antes de entregarlo.
 *
 * Lo que pasaba en el piloto de Carver: el bot copiaba el `brochureUrl` del catálogo y lo pegaba en
 * el chat sin comprobar nada. Ese enlace es un visor HTML de Bitrix24 alojado en el portal de OTRA
 * institución (uachile.bitrix24.es), y si el archivo se movía o el enlace caducaba, el cliente
 * recibía una página de error con total seguridad.
 *
 * Acá se comprueba, con caché, que el enlace responde, que lo que hay detrás es un PDF —o el visor de
 * un PDF—, y que ese PDF es el del programa pedido (el visor expone el nombre del archivo en el
 * título). Si algo falla, no se entrega ningún enlace: el bot lo dice y el asesor lo envía.
 */

export type Formato = 'pdf' | 'visor_pdf';

export type BrochureVerificado = { ok: true; programa: string; url: string; formato: Formato; archivo?: string };
export type BrochureNoDisponible = { ok: false; programa?: string; motivo: string };
export type ResultadoBrochure = BrochureVerificado | BrochureNoDisponible;

type Verificacion = { ok: true; formato: Formato; archivo?: string } | { ok: false; motivo: string };

const CACHE_OK_MS = 6 * 3600_000;
const CACHE_FALLA_MS = 10 * 60_000; // una falla puntual no debe dejar el brochure caído por horas
const TIMEOUT_MS = 8000;
const MAX_HTML = 400_000;
const cache = new Map<string, { hasta: number; v: Verificacion }>();

const norm = (s: string) =>
  (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const GENERICAS = new Set(['maestria', 'licenciatura', 'master', 'bachelor', 'science', 'arts', 'curso', 'programa']);

/** ¿El nombre del archivo corresponde al programa? Compara las palabras significativas del programa
 *  (las de 4+ letras, sin "maestría"/"licenciatura") contra el nombre del archivo. */
export function archivoCorrespondeAPrograma(archivo: string, programa: string): boolean {
  const a = ` ${norm(archivo.replace(/\.pdf$/i, '').replace(/^br\s*-\s*/i, ''))} `;
  const claves = norm(programa)
    .split(' ')
    .filter((w) => w.length >= 4 && !GENERICAS.has(w));
  if (!claves.length) return false;
  const presentes = claves.filter((w) => a.includes(` ${w} `) || a.includes(` ${w}`)).length;
  return presentes / claves.length >= 0.7;
}

/** Comprueba un enlace. Inyectable para las pruebas. */
export async function verificarEnlace(url: string, fetchFn: typeof fetch = fetch): Promise<Verificacion> {
  const guardado = cache.get(url);
  if (guardado && guardado.hasta > Date.now()) return guardado.v;

  let v: Verificacion;
  try {
    const r = await fetchFn(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': 'Mozilla/5.0 (verificacion-brochure)' },
    });
    const tipo = (r.headers.get('content-type') ?? '').toLowerCase();
    if (r.status !== 200) v = { ok: false, motivo: `http_${r.status}` };
    else if (tipo.includes('application/pdf')) {
      const cabecera = Buffer.from(await r.arrayBuffer()).subarray(0, 5).toString('latin1');
      v = cabecera === '%PDF-' ? { ok: true, formato: 'pdf' } : { ok: false, motivo: 'pdf_corrupto' };
    } else if (tipo.includes('text/html')) {
      const html = (await r.text()).slice(0, MAX_HTML);
      const titulo = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? '';
      // El visor de documentos de Bitrix24 pone el nombre del archivo como título de la página.
      v = /\.pdf$/i.test(titulo) ? { ok: true, formato: 'visor_pdf', archivo: titulo } : { ok: false, motivo: 'no_es_pdf' };
    } else v = { ok: false, motivo: 'formato_desconocido' };
  } catch (e) {
    v = { ok: false, motivo: /timeout|abort/i.test(String(e)) ? 'timeout' : 'error_red' };
  }
  cache.set(url, { hasta: Date.now() + (v.ok ? CACHE_OK_MS : CACHE_FALLA_MS), v });
  return v;
}

/** Brochure verificado del programa pedido (por nombre o por la URL de su ficha). */
export async function obtenerBrochure(
  input: { programa?: string; url?: string },
  fetchFn: typeof fetch = fetch,
): Promise<ResultadoBrochure> {
  const d = getDetalle({ url: input?.url, nombre: input?.programa });
  if (!d) return { ok: false, programa: input?.programa, motivo: 'programa_no_encontrado' };
  const tipo = PROGRAMAS.find((p) => p.url === d.url || p.nombre === d.nombre)?.tipo;
  if (tipo && !esTipoComercializable(tipo)) return { ok: false, programa: d.nombre, motivo: 'programa_no_comercializable' };

  const url = (d as any).brochurePdfUrl ?? d.brochureUrl;
  if (!url) return { ok: false, programa: d.nombre, motivo: 'sin_brochure' };

  const v = await verificarEnlace(url, fetchFn);
  if (!v.ok) {
    log.warn('brochure no verificado', { programa: d.nombre, motivo: v.motivo });
    return { ok: false, programa: d.nombre, motivo: v.motivo };
  }
  if (v.formato === 'visor_pdf' && v.archivo && !archivoCorrespondeAPrograma(v.archivo, d.nombre)) {
    log.warn('brochure de otro programa', { programa: d.nombre, archivo: v.archivo });
    return { ok: false, programa: d.nombre, motivo: 'no_corresponde_al_programa' };
  }
  return { ok: true, programa: d.nombre, url, formato: v.formato, archivo: v.archivo };
}

/** Solo para pruebas: vacía la caché de verificaciones. */
export function _limpiarCacheBrochures(): void {
  cache.clear();
}
