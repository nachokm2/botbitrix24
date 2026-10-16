import { callCrm } from '../bitrix/client';
import { config } from '../config';
import { audit } from '../obs/audit';
import { log } from '../log';
import type { Auth } from '../store';

/**
 * El documento académico del postulante, guardado en el campo que corresponde a SU programa.
 *
 * No es uno solo: lo que Carver pide depende del nivel al que entra, y así está escrito en los
 * requisitos de cada ficha.
 *
 *   Licenciatura → "Diploma oficial de escuela secundaria o equivalente"
 *   Maestría     → "título profesional o grado académico"
 *
 * Por eso el tipo NO lo elige el modelo: lo decide el código a partir del programa de la persona.
 * Un diploma de secundaria archivado como título universitario pasa desapercibido hasta que alguien
 * revisa la matrícula y descubre que falta el documento que de verdad hacía falta.
 *
 * Y nunca se guarda en el campo de la cédula: son documentos distintos, los revisa gente distinta,
 * y mezclarlos obliga a pedirlos de nuevo.
 */

export type NivelAcademico = 'licenciatura' | 'maestria';

/** Qué documento pide cada nivel, con el nombre que entiende una persona. */
export const DOCUMENTO_DE: Record<NivelAcademico, string> = {
  licenciatura: 'diploma de enseñanza media',
  maestria: 'título profesional o grado académico',
};

function campoPara(nivel: NivelAcademico): string {
  return nivel === 'licenciatura' ? config.ufDiplomaSecundaria : config.ufTituloUniversitario;
}

/** El nivel al que postula, deducido del programa. Sin programa no se adivina. */
export function nivelDelPrograma(programa: string | null | undefined): NivelAcademico | null {
  const p = String(programa ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
  if (!p) return null;
  if (p.startsWith('licenciatura') || p.startsWith('bachelor')) return 'licenciatura';
  if (p.startsWith('maestria') || p.startsWith('master') || p.startsWith('magister')) return 'maestria';
  return null;
}

export type ResultadoDocumento =
  | { ok: true; nivel: NivelAcademico; documento: string }
  | { ok: false; motivo: 'sin_deal' | 'sin_programa' | 'sin_campo' | 'fallo_guardado' };

/**
 * Guarda la imagen del documento en la negociación.
 *
 * `programa` sale de la ficha, no de lo que diga la persona: es lo que determina qué documento
 * corresponde, y por tanto dónde se archiva.
 *
 * No devuelve ok si la escritura falló. Marcar como recibido un documento que no se guardó es el
 * peor desenlace posible acá: nadie lo vuelve a pedir y la matrícula se traba semanas después, sin
 * que quede claro por qué.
 */
export async function registrarDocumentoAcademico(
  opts: { dealId?: number; programa?: string | null; base64: string; mediaType: string },
  auth: Auth,
): Promise<ResultadoDocumento> {
  if (!opts.dealId) return { ok: false, motivo: 'sin_deal' };
  const nivel = nivelDelPrograma(opts.programa);
  if (!nivel) return { ok: false, motivo: 'sin_programa' };
  const campo = campoPara(nivel);
  if (!campo) return { ok: false, motivo: 'sin_campo' };

  const ext = opts.mediaType.includes('png') ? 'png' : opts.mediaType.includes('pdf') ? 'pdf' : 'jpg';
  const nombre = `${nivel === 'licenciatura' ? 'diploma-secundaria' : 'titulo-universitario'}-deal-${opts.dealId}.${ext}`;
  try {
    await callCrm(
      'crm.deal.update',
      { id: opts.dealId, fields: { [campo]: { fileData: [nombre, opts.base64] } } },
      auth,
    );
    await audit({
      type: 'documento_academico',
      crmEntity: `deal#${opts.dealId}`,
      detail: { nivel, campo, documento: DOCUMENTO_DE[nivel] },
    }).catch(() => {});
    log.info('documento académico guardado', { dealId: opts.dealId, nivel, campo });
    return { ok: true, nivel, documento: DOCUMENTO_DE[nivel] };
  } catch (e) {
    log.warn('no se pudo guardar el documento académico', { err: String(e), dealId: opts.dealId, nivel });
    return { ok: false, motivo: 'fallo_guardado' };
  }
}
