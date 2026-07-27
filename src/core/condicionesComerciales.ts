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
    reglaCuota: 'el arancel se divide en partes iguales por el número de cuotas; la matrícula se paga aparte',
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
  if (
    !p.cotizable ||
    p.arancelConDto === null ||
    p.matricula === null ||
    p.total === null ||
    p.arancelLista === null
  ) {
    return { encontrado: true as const, cotizable: false as const, motivo: p.motivo ?? p.estado, mensaje: mensajeNoCotizable(p) };
  }
  // Las cuotas SIEMPRE se calculan sobre el ARANCEL (la matrícula se paga aparte), dividido por el n.º de
  // cuotas del tipo. Se calculan dos: sobre el arancel de LISTA (por defecto) y sobre el arancel CON DESCUENTO
  // (solo si preguntaron por el descuento). n viene de la planilla (Diplomado 5 / Magíster 24; null en Máster/Esp.).
  const n = p.cuota?.n ?? null;
  const cuotasDefer = {
    disponible: false as const,
    nota: 'Las cuotas de este tipo (Máster/Especialidad) aún no están confirmadas; deriva esa consulta puntual al asesor.',
  };
  const cuotasSobre = (arancel: number) =>
    n
      ? { disponible: true as const, n, valor: fmt(Math.round(arancel / n)), frase: `hasta ${n} cuotas de ${fmt(Math.round(arancel / n))}` }
      : cuotasDefer;
  return {
    encontrado: true as const,
    cotizable: true as const,
    programa: p.nombre + (p.sede ? ` (${p.sede})` : ''),
    codigo: p.codigo,
    // POR DEFECTO se entrega el precio de LISTA (sin revelar el descuento). Anclaje comercial:
    // el descuento se muestra solo si la persona pregunta, para no invitar a pedir uno adicional.
    arancel: fmt(p.arancelLista),
    matricula: fmt(p.matricula),
    total: fmt(p.matricula + p.arancelLista),
    cuotas: cuotasSobre(p.arancelLista), // por defecto: arancel de LISTA ÷ n (matrícula aparte)
    // Descuento institucional: revelar SOLO si preguntan explícitamente por descuentos/becas/promociones.
    descuento: {
      pct: p.dtoPct,
      arancelConDescuento: fmt(p.arancelConDto),
      total: fmt(p.total),
      cuotas: cuotasSobre(p.arancelConDto), // con descuento: arancel c/dto ÷ n (matrícula aparte)
    },
    pago: {
      medios: CONDICIONES_GLOBALES.toku.medios,
      matriculaAparte: true,
      reglaCuota: CONDICIONES_GLOBALES.toku.reglaCuota,
      sinLinkDirecto: true, // el link Toku se genera por batch; NO enviar link ni confirmar estado de pagos
    },
    politica:
      'Entrega PRIMERO el precio de lista: "arancel" + "matricula" + "total". Las cuotas se calculan sobre el ' +
      'ARANCEL y la matrícula se paga aparte: por defecto usa "cuotas" (sobre el arancel de lista). NO menciones el ' +
      'descuento por iniciativa propia. Revela el bloque "descuento" (pct, arancelConDescuento, total y ' +
      'descuento.cuotas — cuota sobre el arancel con descuento) SOLO si la persona pregunta explícitamente si hay ' +
      'descuentos, becas, rebajas o promociones; nunca ofrezcas un descuento adicional. No envíes link de pago ni ' +
      'confirmes pagos.',
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
