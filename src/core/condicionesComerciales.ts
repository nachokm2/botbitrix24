import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Capa de datos comercial (precios, descuento institucional, condiciones Toku, escalamiento) para que el
// agente responda objeciones de precio/financiamiento con CIFRAS REALES en vez del arancel de lista.
// Los datos por programa se generan desde data/capa-datos-postgrados.md con scripts/build-condiciones.ts.
// Reemplaza como fuente de verdad de PRECIO al arancel de detalle_programa (que era el de lista, sin dto).

type Cuota = { monto: number; n: number };
export type ProgramaComercial = {
  codigo: string | null;
  nombre: string;
  tipo: string;
  area: string;
  modalidad: string;
  sede: string | null;
  matricula: number | null;
  arancelLista: number | null;
  dtoPct: number | null;
  arancelConDto: number | null;
  total: number | null;
  cuota: Cuota | null;
  cuotasMaxTipo: number | null;
  estado: string;
  cotizable: boolean;
  motivo?: string;
};

const DATA_PATH = fileURLToPath(new URL('./condicionesComerciales.data.json', import.meta.url));
const { programas } = JSON.parse(readFileSync(DATA_PATH, 'utf8')) as { programas: ProgramaComercial[] };

/** Reglas globales CONFIRMADAS de la capa de datos (§2 Toku, §4 escalamiento). Lo POR CONFIRMAR se omite. */
export const CONDICIONES_GLOBALES = {
  toku: {
    medios: 'tarjeta de débito o crédito',
    reglaCuota: 'el precio del programa se divide en partes iguales por el número de cuotas',
    cuotasPorTipo: { Diplomado: 5, 'Magíster': 24 } as Record<string, number>,
  },
  // Único canal de derivación a soporte/postmatrícula (deuda, pago, matrícula, becas, reclamo, técnico).
  soporte: {
    url: 'https://postgrados.uautonoma.cl/soporte/',
    area: 'Postmatrículas',
    sla: '2 días hábiles',
  },
  matriculaAparteDelArancel: true,
  soloDescuentoInstitucional: true, // beneficios adicionales (ex-alumno, convenio, etc.) POR CONFIRMAR → no mencionar
} as const;

/** Casos de SOPORTE/postmatrícula: el bot NO los resuelve, deriva al formulario web (§4). */
export const CASOS_SOPORTE = [
  'deuda',
  'estado_de_cuenta',
  'estado_de_matricula',
  'estado_de_pago',
  'becas_institucionales',
  'reclamo',
  'problema_tecnico',
] as const;

const fmt = (n: number) => '$' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/** Normaliza un nombre de programa: minúsculas, sin acentos, sin el prefijo de tipo ("Magíster en …"). */
function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/^(magister|diplomado|especialidad|master)\s+(en|de|del|de la)\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Programas que el bot NO debe proponer ni cotizar: masivos con arancel liberado (becas) aún no
// habilitados para venta (tienen otra fecha de salida). Se excluyen de consultar_programas.
const NOMBRES_NO_OFERTABLES = new Set(
  programas.filter((p) => p.motivo === 'masivo_no_habilitado').map((p) => norm(p.nombre)),
);

/** ¿El programa NO se debe ofertar proactivamente (beca/masivo no habilitado)? Recibe el nombre del
 *  catálogo (con o sin prefijo de tipo). Úsalo para filtrarlo de las recomendaciones. */
export function esProgramaNoOfertable(nombre: string): boolean {
  return NOMBRES_NO_OFERTABLES.has(norm(nombre));
}

function mensajeNoCotizable(p: ProgramaComercial): string {
  if (p.motivo === 'masivo_no_habilitado')
    return 'Ese programa es un beneficio/beca que aún NO está habilitado para matrícula (tiene otra fecha de salida). No lo ofrezcas ni lo cotices; registra el interés con registrar_interes_crm y ofrece avisarle apenas se habilite.';
  if (p.motivo === 'nuevo_sin_precio')
    return 'Ese programa es nuevo y su información de precios estará disponible próximamente. Ofrece derivar al asesor comercial para avisarle apenas esté.';
  return 'Ese programa no está disponible para cotización en este momento. Ofrece derivar al asesor comercial.';
}

function cotizacion(p: ProgramaComercial) {
  if (!p.cotizable || p.arancelConDto === null || p.matricula === null || p.total === null) {
    return { encontrado: true as const, cotizable: false as const, motivo: p.motivo ?? p.estado, mensaje: mensajeNoCotizable(p) };
  }
  const esMasivo = p.dtoPct === 100; // arancel liberado: no hay arancel que financiar
  const cuotas = p.cuota
    ? { disponible: true, frase: `hasta ${p.cuota.n} cuotas de ${fmt(p.cuota.monto)}`, n: p.cuota.n, monto: fmt(p.cuota.monto) }
    : esMasivo
      ? { disponible: false, nota: 'Arancel liberado: se paga solo la matrícula, no hay cuotas de arancel.' }
      : { disponible: false, nota: 'Las cuotas de este tipo (Máster/Especialidad) aún no están confirmadas; deriva esa consulta puntual al asesor.' };
  return {
    encontrado: true as const,
    cotizable: true as const,
    programa: p.nombre + (p.sede ? ` (${p.sede})` : ''),
    codigo: p.codigo,
    matricula: fmt(p.matricula),
    arancelLista: p.arancelLista !== null ? fmt(p.arancelLista) : null,
    descuentoPct: p.dtoPct,
    arancelConDescuento: fmt(p.arancelConDto),
    total: fmt(p.total),
    soloMatricula: p.dtoPct === 100, // masivo con arancel liberado: paga solo la matrícula
    pago: {
      medios: CONDICIONES_GLOBALES.toku.medios,
      cuotas,
      matriculaAparte: true,
      reglaCuota: CONDICIONES_GLOBALES.toku.reglaCuota,
      sinLinkDirecto: true, // el link Toku se genera por batch; NO enviar link ni confirmar estado de pagos
    },
    nota:
      'Comunica SOLO el descuento institucional; no menciones otros beneficios (no confirmados). No envíes link de pago ' +
      'ni confirmes/rechaces pagos. La matrícula se paga aparte del arancel.',
  };
}

/**
 * Devuelve las condiciones comerciales (precio con descuento, total, cuotas Toku) de un programa por su
 * nombre. Si hay varios con el mismo nombre (mismas sedes Santiago/Temuco) y no se indica sede → pide precisar.
 * Si el programa no cotiza (PAUSA/SUSPENDIDO/nuevo/bloqueado) → devuelve el motivo y guion de derivación.
 * Sin `programa` → devuelve las reglas generales de financiamiento (Toku) para explicarlas.
 */
export function buscarCondiciones(programa?: string, sede?: string) {
  if (!programa || !programa.trim()) {
    return {
      encontrado: false as const,
      general: true as const,
      financiamiento: CONDICIONES_GLOBALES.toku,
      nota: 'Para dar el valor exacto necesito el programa. Puedes explicar las formas de pago en general con estos datos.',
    };
  }
  const q = norm(programa);
  let matches = programas.filter((p) => norm(p.nombre) === q);
  if (matches.length === 0) {
    matches = programas.filter((p) => {
      const n = norm(p.nombre);
      return n.includes(q) || q.includes(n);
    });
  }
  if (matches.length === 0) {
    return { encontrado: false as const, mensaje: 'No encuentro ese programa en la planilla oficial. Ofrece derivar a un asesor comercial.' };
  }
  if (matches.length > 1 && sede) {
    const s = norm(sede);
    const bySede = matches.filter((p) => p.sede && norm(p.sede) === s);
    if (bySede.length) matches = bySede;
  }
  if (matches.length > 1) {
    return {
      encontrado: true as const,
      ambiguo: true as const,
      mensaje: 'Hay más de un programa con ese nombre (distintas sedes). Pide precisar la sede antes de cotizar.',
      opciones: matches.map((p) => ({ nombre: p.nombre, sede: p.sede, codigo: p.codigo, estado: p.estado })),
    };
  }
  return cotizacion(matches[0]);
}
