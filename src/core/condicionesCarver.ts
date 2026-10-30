import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { equivalencias } from './tipoCambio';
import { esTipoComercializable, MENSAJE_NO_COMERCIALIZABLE } from './oferta';
import { condicionVigente, ajustesPrecios } from './ajustes';
import { REABRE_POR_DEFECTO } from './ajustesProgramas';

// Planilla comercial de Carver, validada con la dirección. La genera scripts/build-carver-precios.ts
// desde data/carver/precios-carver.csv — ver ese script antes de tocar nada acá.
//
// Carver cotiza distinto de Postgrados y por eso tiene su propio módulo: hay TRES formas de pago con
// precios fijos distintos (mensualidades, semestral y contado), la beca del 50% la puede ofrecer el
// agente directamente, y lo más delicado — contado y semestral NO llevan matrícula y ya vienen con
// el descuento aplicado, así que volver a restarles 50% da un precio que no existe.

type Pago = { n: number; monto: number };
export type ProgramaCarver = {
  nombre: string;
  tipo: string;
  gratis?: boolean;
  certificadoUsd?: number;
  arancelLista?: number;
  becaPct?: number;
  arancelConBeca?: number;
  matricula?: number;
  matriculaRegular?: number;
  mensualidades?: Pago;
  semestral?: Pago;
  contado?: { total: number; porAnio?: number; anios?: number };
  cotizable: boolean;
  motivoNoCotizable?: string;
  /** Con cupos completos: cuándo reabre la matrícula, en palabras. Lo fija el panel de configuración. */
  reabre?: string;
};

const DATA = JSON.parse(
  readFileSync(fileURLToPath(new URL('../ai/carver.condiciones.data.json', import.meta.url)), 'utf8'),
) as { programas: ProgramaCarver[] };

/** La planilla con lo publicado en el panel (precios y disponibilidad). Se arma en cada consulta para
 *  que un cambio publicado rija en la conversación siguiente, sin reiniciar el bot. */
const programasVigentes = () => DATA.programas.map(condicionVigente);

// Los costos que NO están en el arancel (titulación, inscripción, retiro) se fijan en la sección
// Precios del panel; sin nada publicado son los de siempre (core/promptObjeciones.ts).
export const BECA_CARVER = 'Beca George Washington Carver Grant';

const norm = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

export function matchProgramaCarver(nombre: string): ProgramaCarver[] {
  const n = norm(nombre);
  if (!n) return [];
  const programas = programasVigentes();
  const exacto = programas.filter((p) => norm(p.nombre) === n);
  if (exacto.length) return exacto;
  const contiene = programas.filter((p) => norm(p.nombre).includes(n) || n.includes(norm(p.nombre)));
  if (contiene.length) return contiene;
  // Último recurso: todas las palabras significativas del pedido aparecen en el nombre.
  const palabras = n.split(' ').filter((w) => w.length >= 4);
  return palabras.length ? programas.filter((p) => palabras.every((w) => norm(p.nombre).includes(w))) : [];
}

/** Cuándo reabre la matrícula de un programa con cupos completos, en palabras ("marzo de 2027"). */
export function reaperturaDe(nombre: string): string {
  return matchProgramaCarver(nombre)[0]?.reabre || REABRE_POR_DEFECTO;
}

/** Condiciones comerciales de UN programa de Carver, en cifras y no en prosa.
 *
 *  `incluirCostosAdicionales` lo decide el código según lo que preguntó el cliente (ver
 *  core/guardRespuesta.ts:preguntaPorCostosAdicionales), no el modelo. Antes los costos que no están
 *  en el arancel venían en TODA cotización, y el modelo terminaba nombrando el fee de titulación
 *  (USD 125) en cada respuesta de precio aunque nadie lo hubiera preguntado (hallazgo 5). */
export function buscarCondicionesCarver(programa?: string, opts: { incluirCostosAdicionales?: boolean } = {}) {
  if (!programa || !programa.trim()) {
    return {
      encontrado: false as const,
      general: true as const,
      moneda: 'USD',
      nota: 'Para dar el valor exacto necesito el programa. Las licenciaturas y maestrías tienen beca del 50% y tres formas de pago.',
    };
  }
  // Fuera de la oferta autorizada (NOOCs y cursos): no se cotiza, ni siquiera el certificado.
  const todos = matchProgramaCarver(programa);
  const matches = todos.filter((p) => esTipoComercializable(p.tipo));
  if (todos.length > 0 && matches.length === 0) {
    return { encontrado: true as const, programa: todos[0].nombre, comercializable: false as const, nota: MENSAJE_NO_COMERCIALIZABLE };
  }
  if (matches.length === 0) {
    return { encontrado: false as const, mensaje: 'No encuentro ese programa en la planilla de Carver. Ofrece derivar a un asesor.' };
  }
  if (matches.length > 1) {
    return {
      encontrado: true as const,
      ambiguo: true as const,
      opciones: matches.map((p) => p.nombre),
      nota: 'Hay más de un programa que coincide: pregunta cuál le interesa antes de cotizar.',
    };
  }
  const p = matches[0];

  // Con cupos completos SÍ se informa el valor: la persona necesita el precio para decidir si espera
  // a que reabra (la fecha se fija en el panel de configuración). Lo que no se hace es prometer cupo ni
  // fecha de inicio. Antes se negaba a cotizar, y eso dejaba sin respuesta a quien preguntaba por los
  // dos programas de mayor valor.
  if (!p.cotizable && p.motivoNoCotizable !== 'cupos completos') {
    return {
      encontrado: true as const,
      programa: p.nombre,
      cotizable: false as const,
      motivo: p.motivoNoCotizable ?? 'no disponible',
      nota: 'Este programa no está disponible para matrícula hoy. NO lo cotices: registra el interés y ofrece avisarle cuando se habilite.',
    };
  }
  const avisoCupos = !p.cotizable
    ? `NO DISPONIBLE AHORA: este programa tiene los cupos completos y la matrícula reabre en ${(p.reabre || REABRE_POR_DEFECTO).toUpperCase()}. Dilo CLARAMENTE antes del precio, para que la persona no crea que puede inscribirse hoy. Puedes darle el valor y las formas de pago para que decida si quiere esperar, pero NO prometas cupo ni fecha de inicio, y registra su interés con registrar_interes_crm para avisarle cuando abra.`
    : '';

  if (p.gratis) {
    return {
      encontrado: true as const,
      programa: p.nombre,
      tipo: p.tipo,
      moneda: 'USD',
      gratis: true as const,
      certificadoUsd: p.certificadoUsd,
      nota: `El curso es gratis. El certificado cuesta USD ${p.certificadoUsd}. Si ya es estudiante de Carver, el curso y el certificado son gratis.`,
    };
  }

  const mens = p.mensualidades;
  return {
    encontrado: true as const,
    programa: p.nombre,
    tipo: p.tipo,
    moneda: 'USD',
    arancelLista: p.arancelLista,
    beca: { nombre: BECA_CARVER, pct: p.becaPct, arancel: p.arancelConBeca },
    formasDePago: {
      mensualidades: mens
        ? {
            cuotas: mens.n,
            montoCuota: mens.monto,
            total: p.arancelConBeca,
            matricula: p.matricula,
            matriculaRegular: p.matriculaRegular,
            nota: `Única forma de pago que cobra matrícula: USD ${p.matricula} (regular USD ${p.matriculaRegular}), aparte del arancel.`,
          }
        : undefined,
      semestral: p.semestral
        ? {
            pagos: p.semestral.n,
            montoPago: p.semestral.monto,
            total: p.semestral.n * p.semestral.monto,
            matricula: 0,
            nota: 'Precio fijo y SIN matrícula. Ya viene con el beneficio aplicado: no le restes otro 50%.',
          }
        : undefined,
      contado: p.contado
        ? {
            total: p.contado.total,
            porAnio: p.contado.porAnio,
            anios: p.contado.anios,
            matricula: 0,
            nota: 'La opción más barata. Precio fijo y SIN matrícula. Ya viene con el beneficio aplicado: no le restes otro 50%.',
          }
        : undefined,
    },
    // Solo si la persona preguntó explícitamente por costos fuera del arancel (titulación, total…).
    ...(opts.incluirCostosAdicionales
      ? {
          costosAdicionales: ajustesPrecios().costosAdicionales,
          nota_costos:
            'La persona preguntó por costos fuera del arancel: responde SOLO lo que preguntó (si fue la titulación, solo la titulación).',
        }
      : {}),
    // Equivalentes aproximados en la moneda de cada país. Una clienta colombiana preguntó por "la
    // beca de 2 millones de pesos" y recibió solo dólares: la gente piensa en su moneda. Si las
    // tasas no están disponibles viene null y el bot habla solo en dólares (ver core/tipoCambio.ts).
    equivalencias: equivalencias({
      arancelLista: p.arancelLista,
      arancelConBeca: p.arancelConBeca,
      matricula: p.matricula,
      cuotaMensual: mens?.monto,
      totalMensualidades: p.arancelConBeca,
      pagoSemestral: p.semestral?.monto,
      totalSemestral: p.semestral ? p.semestral.n * p.semestral.monto : undefined,
      totalContado: p.contado?.total,
    }),
    nota: `${avisoCupos ? avisoCupos + ' ' : ''}La ${BECA_CARVER} (${p.becaPct}%) puedes ofrecerla directamente. Entrega las tres formas de pago cuando pregunten por el valor.`,
  };
}
