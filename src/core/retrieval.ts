import { PROGRAMAS, type Programa } from '../ai/catalog';
import { DETALLES } from '../ai/detalles';

// M5 — Servicio de recuperación ÚNICO del catálogo (usado por todos los canales vía catalogTool).
// Mejora el recall respecto al filtro por substring exacto anterior:
//   1) Indexa TEXTO ENRIQUECIDO (nombre + facultad + tipo + modalidad + descripción/objetivos/
//      dirigido-a/requisitos/malla del detalle) → matchea aunque la palabra no esté en el nombre.
//   2) EXPANDE sinónimos/áreas ("rrhh"→personas/talento, "abogado"→derecho, "mba"→administración…).
//   3) RANKEA por relevancia (el nombre pesa más que el detalle) y devuelve ordenado.
// Es DETERMINÍSTICO: solo devuelve programas reales del catálogo (nunca inventa datos ni precios).
//
// pgvector-ready: la interfaz `retrieve(filters) → Programa[]` es estable; un backend vectorial
// (embeddings + pgvector) puede reemplazar el scorer léxico sin tocar a los consumidores.

const strip = (s: string) => (s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const slugFromUrl = (u: string) => u.replace(/\/+$/, '').split('/').pop() ?? u;

// Palabras que no aportan a la búsqueda (conversacionales + del dominio) — se ignoran al tokenizar.
const STOP = new Set([
  'de', 'la', 'el', 'en', 'y', 'para', 'del', 'los', 'las', 'un', 'una', 'con', 'por', 'que', 'mi', 'me',
  'programa', 'programas', 'curso', 'cursos', 'magister', 'magíster', 'diplomado', 'diplomados',
  'especialidad', 'especialidades', 'sobre', 'info', 'informacion', 'información', 'quiero', 'busco',
  'hola', 'buenas', 'algo', 'gustaria', 'gustaría', 'interesa', 'interesado', 'interesada', 'saber',
  'mas', 'más', 'cual', 'cuál', 'cuales', 'cuáles', 'tienen', 'tiene', 'hay', 'estudiar', 'area', 'área',
  'tema', 'temas', 'relacionado', 'relacionados', 'algun', 'algún', 'alguna', 'ustedes', 'porfa',
]);

// Sinónimos/áreas: si la consulta CONTIENE la clave (frase o palabra), se agregan estos términos
// canónicos a la búsqueda. Cubre el vocabulario coloquial del prospecto → vocabulario del catálogo.
const SYNONYMS: Record<string, string[]> = {
  'ia': ['inteligencia artificial'],
  'machine learning': ['inteligencia artificial', 'datos'],
  'data science': ['analitica', 'datos'],
  'ciencia de datos': ['analitica', 'datos'],
  'analisis de datos': ['analitica', 'datos'],
  'big data': ['analitica', 'datos'],
  'rrhh': ['personas', 'talento'],
  'recursos humanos': ['personas', 'talento'],
  'capital humano': ['personas', 'talento'],
  'talento': ['personas'],
  'plata': ['finanzas', 'financiera'],
  'dinero': ['finanzas', 'financiera'],
  'contabilidad': ['finanzas', 'financiera'],
  'impuestos': ['tributario', 'finanzas'],
  'abogado': ['derecho', 'juridico'],
  'abogada': ['derecho', 'juridico'],
  'legal': ['derecho', 'juridico'],
  'juridico': ['derecho'],
  'leyes': ['derecho'],
  'profesor': ['educacion', 'docencia', 'pedagogia'],
  'profesora': ['educacion', 'docencia'],
  'docente': ['educacion', 'docencia'],
  'colegio': ['educacion', 'escolar'],
  'escuela': ['educacion', 'escolar'],
  'pedagogia': ['educacion'],
  'medico': ['salud', 'clinica', 'medicina'],
  'medica': ['salud', 'clinica'],
  'clinica': ['salud'],
  'enfermeria': ['salud'],
  'kinesiologia': ['salud', 'musculoesqueletica'],
  'psicologo': ['psicologia'],
  'psicologa': ['psicologia'],
  'salud mental': ['psicologia', 'clinica'],
  'empresa': ['administracion', 'negocios', 'gestion'],
  'empresas': ['administracion', 'negocios', 'gestion'],
  'negocios': ['administracion', 'gestion'],
  'gerencia': ['administracion', 'direccion', 'gestion'],
  'gerente': ['administracion', 'direccion'],
  'liderazgo': ['direccion', 'gestion'],
  'mba': ['administracion', 'empresas', 'direccion'],
  'computacion': ['ingenieria', 'informatica', 'software'],
  'programacion': ['ingenieria', 'informatica', 'software'],
  'sistemas': ['ingenieria', 'informatica'],
  'software': ['ingenieria', 'informatica'],
  'tecnologia': ['ingenieria', 'informatica'],
  'construccion': ['construccion', 'obras', 'edificacion'],
  'obras': ['construccion'],
  'arquitectura': ['construccion'],
  'medioambiente': ['ambiental', 'sostenible', 'sostenibilidad'],
  'medio ambiente': ['ambiental', 'sostenible', 'sostenibilidad'],
  'sustentable': ['sostenible', 'sostenibilidad', 'ambiental'],
  'sustentabilidad': ['sostenible', 'sostenibilidad', 'ambiental'],
  'logistica': ['operaciones', 'suministro', 'cadena'],
  'marketing': ['marketing', 'digital'],
  'publicidad': ['marketing', 'comunicacion'],
  'ventas': ['marketing', 'negocios'],
  'proyectos': ['proyectos', 'formulacion'],
  'salud publica': ['salud', 'organizaciones de salud'],
  'municipal': ['municipal', 'publica'],
  'gobierno': ['publica', 'gobierno'],
  'sector publico': ['publica', 'gobierno'],
  'familia': ['familia', 'infancia'],
  'ninos': ['infancia', 'familia'],
  'niños': ['infancia', 'familia'],
  'inclusion': ['inclusion', 'convivencia', 'diversidad'],
  'inclusión': ['inclusion', 'convivencia', 'diversidad'],
  'penal': ['penal', 'procesal'],
  'laboral': ['trabajo', 'laboral'],
  'deporte': ['deportes', 'actividad fisica'],
  'deportes': ['deportes', 'actividad fisica'],
};

type Indexed = { p: Programa; hay: string; nombre: string };

// Índice construido una sola vez al cargar el módulo (join catálogo + detalle enriquecido).
const INDEX: Indexed[] = PROGRAMAS.map((p) => {
  const d: any = DETALLES[slugFromUrl(p.url)] ?? {};
  const extra = [
    d.descripcion,
    d.objetivoGeneral,
    Array.isArray(d.objetivosEspecificos) ? d.objetivosEspecificos.join(' ') : '',
    Array.isArray(d.dirigidoA) ? d.dirigidoA.join(' ') : '',
    d.requisitos,
    Array.isArray(d.malla) ? d.malla.map((s: any) => (s.modulos ?? []).join(' ')).join(' ') : '',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    p,
    nombre: strip(`${p.nombre} ${p.facultad}`),
    hay: strip(`${p.nombre} ${p.facultad} ${p.tipo} ${p.modalidad} ${extra}`),
  };
});

/** Expande la consulta con sinónimos/áreas y tokeniza (ignora stopwords y palabras < 3 chars). */
function needlesFrom(rawText: string): string[] {
  const raw = strip(rawText).trim().replace(/\bi\.?\s?a\.?\b/g, 'inteligencia artificial');
  const out = new Set<string>();
  const add = (w: string) => {
    const t = w.trim();
    if (t.length >= 3 && !STOP.has(t)) out.add(t);
  };
  for (const tok of raw.split(/\s+/)) add(tok);
  for (const [key, vals] of Object.entries(SYNONYMS)) {
    if (raw.includes(key)) for (const v of vals) for (const w of v.split(/\s+/)) add(w);
  }
  // Si tras filtrar no quedó nada (p. ej. consulta muy corta), usa el texto crudo como needle.
  if (out.size === 0 && raw) out.add(raw);
  return [...out];
}

export type RetrieveFilters = { tipo?: string; facultad?: string; modalidad?: string; texto?: string };

/**
 * Recupera programas del catálogo. Con `texto`, rankea por relevancia (nombre > detalle) y descarta
 * los que no matchean. Solo con filtros (tipo/facultad/modalidad), devuelve todos en orden de catálogo.
 */
export function retrieve(filters: RetrieveFilters): Programa[] {
  const { tipo, facultad, modalidad, texto } = filters ?? {};
  const nf = strip(facultad ?? '');
  const base = INDEX.filter(
    (x) =>
      (!tipo || x.p.tipo === tipo) &&
      (!facultad || strip(x.p.facultad).includes(nf)) &&
      (!modalidad || strip(x.p.modalidad) === strip(modalidad)),
  );

  const raw = strip(texto ?? '').trim();
  if (!raw) return base.map((x) => x.p); // solo filtros → orden de catálogo (comportamiento previo)

  const needles = needlesFrom(texto ?? '');
  const scored = base
    .map((x) => {
      let score = 0;
      for (const n of needles) {
        if (x.nombre.includes(n)) score += 10; // match en nombre/facultad: muy relevante
        else if (x.hay.includes(n)) score += 3; // match en el detalle: relevante
      }
      return { p: x.p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.map((x) => x.p);
}
