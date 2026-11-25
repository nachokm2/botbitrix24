import { config } from '../config';
import { marca } from '../marca';
import { contactoDelAsesor } from '../crm/contactoAsesores';

/**
 * La ficha de postulación que se envía cuando la negociación NO tiene una propia.
 *
 * Carver manda a cada persona la ficha de su asesor (core/promptObjeciones.ts, decisión del 13-11-2026).
 * Pero entre el 17 y el 24-11-2026, 241 de 502 chats tenían un responsable sin ficha utilizable: no
 * estaba en ASESORES_CONTACTO (Mauricio Arrieta, Ariel Carter, Gustavo Muñoz, sin responsable) o estaba
 * desactivado en Bitrix (Claudio, Jefferson). El prompt manda entonces a decir «te la hago llegar» y
 * derivar, y nadie la envió: una persona pidió la ficha cuatro veces (chat 1621743) y otras quedaron
 * esperando «mañana desde las 9:00». Cuando el modelo escribía igual un enlace, el guardián lo borraba y
 * quedaba «completa la ficha de postulación:» sin nada.
 *
 * La del equipo es la del punto de entrada (BITRIX_DERIVAR_A, hoy Danna Verdugo), que es quien recibe lo
 * que no tiene responsable, si su ficha está en ASESORES_CONTACTO. Si no, la variable
 * FICHA_POSTULACION_DEFECTO. Sin ninguna de las dos no cambia nada: el bot sigue como antes.
 */

function httpsValido(v: unknown): string | undefined {
  try {
    const u = new URL(String(v ?? '').trim());
    return u.protocol === 'https:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** La ficha del equipo, o undefined si no hay ninguna configurada o la marca no usa ficha. */
export function fichaDelEquipo(): string | undefined {
  if (!marca.matriculaConFormulario) return undefined;
  const delPuntoDeEntrada = config.derivarATodo ? contactoDelAsesor(config.derivarATodo).formulario : undefined;
  return delPuntoDeEntrada ?? httpsValido(config.fichaPostulacionDefecto);
}

/** La ficha que corresponde a este turno: la del asesor si la tiene, y si no la del equipo. */
export function fichaParaElTurno(identidad: { formulario?: string } | null | undefined): string | undefined {
  if (!marca.matriculaConFormulario) return undefined;
  return identidad?.formulario ?? fichaDelEquipo();
}

/** Lo que se agrega al prompt cuando la negociación no tiene ficha propia. Mismo texto que la ficha del
 *  asesor (bloqueIdentidad): el prompt fijo habla de «tu FICHA DE POSTULACIÓN». */
export function bloqueFichaDelEquipo(url: string): string {
  return `\n\nTu FICHA DE POSTULACIÓN es ${url}. Es la que envías en el paso de matrícula, tal cual; nunca otra.`;
}
