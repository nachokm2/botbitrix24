import { conocimientoBase } from './ajustesConocimiento';
// Solo tipos: en ejecución este módulo no depende de ajustes.ts, que es el que lo usa a él.
import type { ErrorCampo, Validacion } from './ajustes';

/**
 * Sección "Acciones" del panel de configuración (ver core/ajustes.ts). Por ahora, los medios de pago:
 * los enlaces de PayPal de importe fijo y el portal de Flywire, que hasta hoy vivían en el documento de
 * la dirección (data/carver/conocimiento-comercial.json) y solo se cambiaban por código.
 *
 * Qué enlace se le da a cada persona NO se decide acá: lo calcula core/mediosPago.ts desde los precios
 * vigentes, y un enlace de PayPal solo se usa si su importe coincide EXACTAMENTE con lo que corresponde
 * pagar. Si no, va Flywire. Esta sección solo mantiene la lista de enlaces.
 *
 * Como son enlaces de pago, la validación es estricta: solo dominios de PayPal para PayPal, y solo
 * carver.university o Flywire para el portal. Un enlace mal pegado no debe poder llegar a un cliente.
 */

export const CONCEPTOS_ENLACE = ['matricula', 'abono_inicial', 'arancel', 'contado'] as const;
export type ConceptoEnlace = (typeof CONCEPTOS_ENLACE)[number];
export type EnlacePayPal = { concepto: ConceptoEnlace; montoUsd: number; url: string };
export type AjustesAcciones = { portalFlywire: string; enlacesPayPal: EnlacePayPal[] };

const MAX_ENLACES = 40;
const HOSTS_PAYPAL = new Set(['paypal.com', 'www.paypal.com', 'paypal.me', 'www.paypal.me']);
const esHostPortal = (h: string) => h === 'carver.university' || h === 'www.carver.university' || h === 'flywire.com' || h.endsWith('.flywire.com');

type MediosDePago = { enlacesPayPal?: EnlacePayPal[]; portalFlywire?: string };
const medios = (): MediosDePago => (conocimientoBase().temas?.medios_de_pago as unknown as MediosDePago | undefined) ?? {};

/** Hay medios de pago que editar donde la marca los tiene cargados (hoy, Carver). */
export const accionesDisponibles = () => Boolean(medios().portalFlywire);

export function accionesPorDefecto(): AjustesAcciones {
  const m = medios();
  return {
    portalFlywire: m.portalFlywire ?? '',
    enlacesPayPal: (m.enlacesPayPal ?? []).map((e) => ({ concepto: e.concepto, montoUsd: e.montoUsd, url: e.url })),
  };
}

const enCentavos = (n: number) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6;

function host(texto: string): string | null {
  try {
    const u = new URL(texto);
    return u.protocol === 'https:' ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

// Los mensajes los lee alguien que no programa: dicen qué corregir, no qué regla se violó.
export function validarAcciones(entrada: unknown): Validacion<AjustesAcciones> {
  const x = (entrada && typeof entrada === 'object' && !Array.isArray(entrada) ? entrada : {}) as Record<string, unknown>;
  const defecto = accionesPorDefecto();
  const errores: ErrorCampo[] = [];

  const portalFlywire = String(x.portalFlywire ?? defecto.portalFlywire).trim();
  const hPortal = host(portalFlywire);
  if (!hPortal || !esHostPortal(hPortal)) {
    errores.push({ campo: 'portalFlywire', mensaje: 'El portal de pagos debe ser una dirección https de carver.university o de Flywire.' });
  }

  const crudos = Array.isArray(x.enlacesPayPal) ? x.enlacesPayPal : x.enlacesPayPal === undefined ? defecto.enlacesPayPal : null;
  const enlacesPayPal: EnlacePayPal[] = [];
  if (!crudos) errores.push({ campo: 'enlacesPayPal', mensaje: 'La lista de enlaces no es válida.' });
  else if (crudos.length > MAX_ENLACES) errores.push({ campo: 'enlacesPayPal', mensaje: `Puedes cargar hasta ${MAX_ENLACES} enlaces.` });
  else {
    const vistos = new Map<string, number>();
    crudos.forEach((crudo, i) => {
      const e = (crudo && typeof crudo === 'object' ? crudo : {}) as Record<string, unknown>;
      const error = (campo: string, mensaje: string) => errores.push({ campo: `enlacesPayPal.${i}.${campo}`, mensaje });
      const concepto = String(e.concepto ?? '') as ConceptoEnlace;
      if (!CONCEPTOS_ENLACE.includes(concepto)) error('concepto', 'Elige qué se paga con este enlace.');
      const monto = e.montoUsd;
      const montoOk = typeof monto === 'number' && Number.isFinite(monto) && monto > 0 && monto <= 100_000 && enCentavos(monto);
      if (!montoOk) error('montoUsd', 'Indica el monto exacto del enlace, en dólares.');
      const url = String(e.url ?? '').trim();
      const h = host(url);
      if (!h || !HOSTS_PAYPAL.has(h)) error('url', 'Pega el enlace de PayPal completo (https://www.paypal.com/…).');
      // Dos enlaces para el mismo concepto y el mismo monto: el bot no sabría cuál dar, y uno de los dos
      // quedaría como enlace fantasma que nadie revisa.
      if (montoOk && CONCEPTOS_ENLACE.includes(concepto)) {
        const clave = `${concepto}|${monto}`;
        if (vistos.has(clave)) error('montoUsd', `Ya hay otro enlace para ${concepto.replace('_', ' ')} por ese mismo monto (fila ${vistos.get(clave)! + 1}).`);
        else vistos.set(clave, i);
      }
      enlacesPayPal.push({ concepto, montoUsd: montoOk ? (monto as number) : 0, url });
    });
  }
  if (errores.length) return { ok: false, errores };
  return { ok: true, valor: { portalFlywire, enlacesPayPal } };
}
