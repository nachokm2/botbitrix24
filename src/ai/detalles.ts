import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { marca } from '../marca';

// Detalle enriquecido por programa (arancel, matrícula, requisitos, descripción,
// objetivos, malla, becas, brochure). Datos reales de postgrados.uautonoma.cl
// (extraídos 2026-06-28). Los datos viven en detalles.data.json para mantenerlos
// separados del código; para refrescar, regenerar ese JSON desde las páginas.
export type DetallePrograma = {
  nombre: string;
  url: string;
  arancel?: string | null;
  matricula?: string | null;
  /** Mes/fecha de inicio de la próxima cohorte, en texto libre (ej. "Fines de septiembre de 2026").
   *  Solo se completa cuando se confirma el dato real; si falta, el bot debe decir que no lo tiene y
   *  ofrecer derivar a un asesor (ver ai/prompt.ts) — nunca inventar un mes. */
  fechaInicio?: string;
  duracion?: string;
  modalidad?: string;
  grado?: string;
  requisitos?: string | null;
  descripcion?: string;
  objetivoGeneral?: string;
  objetivosEspecificos?: string[];
  dirigidoA?: string[];
  becas?: string;
  malla?: { semestre: string; modulos: string[] }[];
  brochureUrl?: string | null;
};

// El archivo depende de la MARCA (ver marca.ts): Postgrados usa el suyo de siempre; Carver el que
// genera scripts/build-carver-data.ts desde el catálogo extraído de carver.university.
const ARCHIVO = marca.catalogo === 'carver' ? './carver.detalles.data.json' : './detalles.data.json';
const DATA_PATH = fileURLToPath(new URL(ARCHIVO, import.meta.url));
export const DETALLES: Record<string, DetallePrograma> = JSON.parse(readFileSync(DATA_PATH, 'utf8'));

const slugFromUrl = (u: string) => u.replace(/\/+$/, '').split('/').pop() ?? u;

/** Sin tildes, mayúsculas ni signos: "Maestría en Administración de Empresas (MBA)" y la del catálogo,
 *  "Maestría en Administración de Empresas MBA", quedan iguales. */
const comparable = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export function getDetalle(opts: { url?: string; nombre?: string }): DetallePrograma | undefined {
  if (opts.url) {
    const d = DETALLES[slugFromUrl(opts.url)];
    if (d) return d;
  }
  if (opts.nombre) {
    const n = opts.nombre.toLowerCase().trim();
    const exacto = Object.values(DETALLES).find(
      (d) => d.nombre.toLowerCase().includes(n) || n.includes(d.nombre.toLowerCase()),
    );
    if (exacto) return exacto;
    // El modelo escribe el nombre a su manera: con paréntesis, el MBA no se encontraba y el bot decía
    // no tener la malla (6 consultas entre el 31-10 y el 02-11). Solo se intenta si lo de arriba falla.
    const c = comparable(opts.nombre);
    if (!c) return undefined;
    return Object.values(DETALLES).find((d) => {
      const dc = comparable(d.nombre);
      return dc.includes(c) || c.includes(dc);
    });
  }
  return undefined;
}
