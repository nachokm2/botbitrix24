import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { matchProgramaCarver } from './condicionesCarver';

/**
 * Qué enlace de pago corresponde a un programa y un concepto.
 *
 * Carver tiene dos medios oficiales. Flywire es un portal SIN monto: sirve siempre. PayPal son seis
 * enlaces de IMPORTE FIJO, y ahí está todo el riesgo — si se entrega el equivocado, la persona paga
 * una cifra que no le corresponde y deshacerlo es caro y lento.
 *
 * Por eso el monto NO lo elige el modelo. Lo calcula este módulo desde la planilla comercial
 * validada (condicionesCarver) según el programa y la forma de pago, y recién entonces busca un
 * enlace de PayPal cuyo importe COINCIDA EXACTAMENTE. Si no hay coincidencia exacta, no se aproxima
 * al más cercano: se entrega el portal de Flywire, que no lleva importe.
 *
 * El caso que lo motivó: el contado del MBA son USD 1.123 y no existe un enlace de PayPal por esa
 * cifra. El más parecido es "Pago al contado USD 900", que es el de las otras doce maestrías —
 * mandarlo habría cobrado 223 dólares de menos y dejado la matrícula a medio pagar.
 */

export type Concepto = 'matricula' | 'abono_inicial' | 'cuota_mensual' | 'pago_semestral' | 'pago_contado';

type EnlacePayPal = { concepto: string; montoUsd: number; url: string };
type Archivo = { temas?: { medios_de_pago?: { enlacesPayPal?: EnlacePayPal[]; portalFlywire?: string } } };

const RUTA = fileURLToPath(new URL('../../data/carver/conocimiento-comercial.json', import.meta.url));

const DATOS: { enlaces: EnlacePayPal[]; portal: string } = (() => {
  try {
    const j = JSON.parse(readFileSync(RUTA, 'utf8')) as Archivo;
    const t = j.temas?.medios_de_pago;
    return { enlaces: Array.isArray(t?.enlacesPayPal) ? t!.enlacesPayPal! : [], portal: t?.portalFlywire ?? '' };
  } catch {
    return { enlaces: [], portal: '' };
  }
})();

/**
 * Qué conceptos de este módulo puede cubrir cada enlace, según cómo lo nombró la dirección.
 *
 * "arancel" cubre las tres formas de pagar el arancel, porque las etiquetas del documento son más
 * gruesas que estos conceptos: el enlace de USD 585 dice "Pago arancel" y en la planilla ese importe
 * es el CONTADO ANUAL de las licenciaturas. Quien desempata no es la etiqueta sino el importe
 * exacto, y ningún arancel (100, 150, 585) choca con un semestral (410, 630, 786) ni con otro
 * contado (900, 1123). Lo que sí se mantiene separado es matrícula de abono inicial: son dos
 * enlaces DISTINTOS por el mismo monto, USD 50, así que por importe solo no se podrían distinguir.
 */
const CONCEPTO_DEL_ENLACE: Record<string, Concepto[]> = {
  matricula: ['matricula'],
  abono_inicial: ['abono_inicial'],
  arancel: ['cuota_mensual', 'pago_semestral', 'pago_contado'],
  contado: ['pago_contado'],
};

export type ResultadoPago =
  | { ok: false; motivo: 'programa_no_encontrado' | 'programa_ambiguo' | 'concepto_sin_monto' | 'sin_configuracion'; nota: string; opciones?: string[] }
  | {
      ok: true;
      programa: string;
      concepto: Concepto;
      montoUsd: number;
      medio: 'paypal' | 'flywire';
      url: string;
      /** Solo en PayPal: la dirección exige decirlo SIEMPRE antes de que la persona pague. */
      avisoComision?: string;
      nota: string;
    };

const AVISO_COMISION = 'Con PayPal se suma la comisión que cobra PayPal: díselo ANTES de que pague, siempre.';

/** El importe exacto de un concepto para un programa, desde la planilla validada. */
function montoDe(p: ReturnType<typeof matchProgramaCarver>[number], concepto: Concepto): number | null {
  switch (concepto) {
    case 'matricula':
      // La matrícula se cobra SOLO en mensualidades (contado y semestral no la llevan). Cobrarla en
      // las otras dos sería cobrar de más.
      return p.mensualidades ? (p.matricula ?? null) : null;
    case 'abono_inicial':
      return p.matricula ?? null;
    case 'cuota_mensual':
      return p.mensualidades?.monto ?? null;
    case 'pago_semestral':
      return p.semestral?.monto ?? null;
    case 'pago_contado':
      return p.contado?.porAnio ?? p.contado?.total ?? null;
    default:
      return null;
  }
}

export function enlaceDePago(programa: string, concepto: Concepto): ResultadoPago {
  if (!DATOS.portal) {
    return { ok: false, motivo: 'sin_configuracion', nota: 'No tengo los medios de pago cargados. Ofrece que el asesor lo coordine.' };
  }
  const matches = matchProgramaCarver(programa ?? '');
  if (!matches.length) {
    return { ok: false, motivo: 'programa_no_encontrado', nota: 'No encuentro ese programa en la planilla. Pregunta cuál es antes de dar un enlace.' };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      motivo: 'programa_ambiguo',
      opciones: matches.map((p) => p.nombre),
      nota: 'Hay más de un programa que coincide: pregunta cuál antes de dar un enlace de pago.',
    };
  }
  const p = matches[0];
  const montoUsd = montoDe(p, concepto);
  if (montoUsd === null || !(montoUsd > 0)) {
    return {
      ok: false,
      motivo: 'concepto_sin_monto',
      nota: `Ese concepto no aplica a ${p.nombre} con esa forma de pago. Confirma cuál quiere pagar antes de dar un enlace.`,
    };
  }

  // Coincidencia EXACTA de concepto e importe. Nunca el más cercano.
  const enlace = DATOS.enlaces.find(
    (e) => e.montoUsd === montoUsd && (CONCEPTO_DEL_ENLACE[e.concepto] ?? []).includes(concepto),
  );
  if (enlace) {
    return {
      ok: true,
      programa: p.nombre,
      concepto,
      montoUsd,
      medio: 'paypal',
      url: enlace.url,
      avisoComision: AVISO_COMISION,
      nota: `Enlace de PayPal por USD ${montoUsd}. Comparte SOLO esta URL, tal cual, y menciona la comisión.`,
    };
  }
  return {
    ok: true,
    programa: p.nombre,
    concepto,
    montoUsd,
    medio: 'flywire',
    url: DATOS.portal,
    nota:
      `No hay un enlace de PayPal por USD ${montoUsd}. Entrega el portal de Flywire, donde se elige el país y ` +
      `se paga en moneda local. NO ofrezcas PayPal para este monto ni prometas enviar otro enlace.`,
  };
}
