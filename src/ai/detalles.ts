import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Detalle enriquecido por programa (arancel, matrícula, requisitos, descripción,
// objetivos, malla, becas, brochure). Datos reales de postgrados.uautonoma.cl
// (extraídos 2026-06-28). Los datos viven en detalles.data.json para mantenerlos
// separados del código; para refrescar, regenerar ese JSON desde las páginas.
export type DetallePrograma = {
  nombre: string;
  url: string;
  arancel?: string | null;
  matricula?: string | null;
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

const DATA_PATH = fileURLToPath(new URL('./detalles.data.json', import.meta.url));
export const DETALLES: Record<string, DetallePrograma> = JSON.parse(readFileSync(DATA_PATH, 'utf8'));

const slugFromUrl = (u: string) => u.replace(/\/+$/, '').split('/').pop() ?? u;

export function getDetalle(opts: { url?: string; nombre?: string }): DetallePrograma | undefined {
  if (opts.url) {
    const d = DETALLES[slugFromUrl(opts.url)];
    if (d) return d;
  }
  if (opts.nombre) {
    const n = opts.nombre.toLowerCase().trim();
    return Object.values(DETALLES).find(
      (d) => d.nombre.toLowerCase().includes(n) || n.includes(d.nombre.toLowerCase()),
    );
  }
  return undefined;
}
