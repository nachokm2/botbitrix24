// Convierte el catálogo extraído de carver.university (data/carver/carver.catalogo.json, ver
// data/carver/build-catalogo.mjs) a los DOS archivos que el bot ya sabe leer:
//   src/ai/carver.programas.data.json  → lista para búsqueda (misma forma que ai/catalog.ts:Programa)
//   src/ai/carver.detalles.data.json   → detalle por programa (ai/detalles.ts:DetallePrograma)
// Así el bot de Carver reutiliza tal cual la búsqueda y el detalle, sin código nuevo.
//   npx tsx scripts/build-carver-data.ts
//
// A PROPÓSITO no copia precios: el sitio de Carver publica DOS valores distintos por programa (la
// ficha y la página "Matrícula y Costos" no coinciden), así que hasta que la institución confirme
// cuál rige, el bot no cotiza (ver src/marca.ts: cotiza=false). El precio queda guardado en
// data/carver/carver.catalogo.json para cuando se confirme.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = resolve('data/carver/carver.catalogo.json');
const OUT_PROGRAMAS = resolve('src/ai/carver.programas.data.json');
const OUT_DETALLES = resolve('src/ai/carver.detalles.data.json');

type Fuente = {
  nombre: string;
  url: string;
  tipo: string;
  nivel: 'pregrado' | 'postgrado' | 'noocs' | 'continuingeducation';
  creditos?: number | null;
  duracion?: string | null;
  modalidad?: string | null;
  requisitos?: string | null;
  dirigidoA?: string | null;
  audiencia?: string | null;
  planEstudios?: string | null;
  descripcion?: string | null;
  objetivos?: string[];
  brochure?: string | null;
  certificacion?: string | null;
};

const TIPO_POR_NIVEL: Record<Fuente['nivel'], string> = {
  pregrado: 'licenciatura',
  postgrado: 'maestria',
  noocs: 'curso',
  continuingeducation: 'curso',
};

const slug = (u: string) => u.replace(/\/+$/, '').split('/').pop() ?? u;

const fuente = JSON.parse(readFileSync(SRC, 'utf8')) as Record<string, Fuente>;
const programas: unknown[] = [];
const detalles: Record<string, unknown> = {};

for (const p of Object.values(fuente)) {
  const tipo = TIPO_POR_NIVEL[p.nivel];

  programas.push({
    nombre: p.nombre,
    tipo,
    facultad: '', // Carver no organiza su oferta por facultad
    modalidad: 'online', // todos los programas son 100% en línea
    duracion: p.duracion ?? '',
    url: p.url,
  });

  // dirigidoA es un array en DetallePrograma; las fichas traen una frase.
  const dirigido = p.dirigidoA ?? p.audiencia ?? null;

  detalles[slug(p.url)] = {
    nombre: p.nombre,
    url: p.url,
    modalidad: p.modalidad ?? '100% en línea, con clases en vivo en español',
    duracion: p.duracion ?? undefined,
    requisitos: p.requisitos ?? null,
    descripcion: p.descripcion ?? undefined,
    dirigidoA: dirigido ? [dirigido] : undefined,
    objetivosEspecificos: p.objetivos?.length ? p.objetivos : undefined,
    grado: p.creditos ? `${p.tipo} · ${p.creditos} créditos` : p.tipo,
    brochureUrl: p.brochure ?? null,
    // arancel/matricula quedan FUERA a propósito: ver el comentario del encabezado.
  };
}

writeFileSync(OUT_PROGRAMAS, JSON.stringify(programas, null, 2) + '\n', 'utf8');
writeFileSync(OUT_DETALLES, JSON.stringify(detalles, null, 2) + '\n', 'utf8');
console.log(`programas: ${programas.length} → ${OUT_PROGRAMAS}`);
console.log(`detalles:  ${Object.keys(detalles).length} → ${OUT_DETALLES}`);
