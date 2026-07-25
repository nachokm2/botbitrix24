import type { CampaignStatus } from './types';
import type { Cierre } from '../ai/clasificadorCierre';

// ── Fase 3: máquina de estados del Deal en campaña ──
// Decide el estado siguiente tras el CIERRE de una llamada. PURA (sin I/O) para testear la lógica de
// negocio en aislamiento (ver ALT-Media-4 de la auditoría). El ejecutor (finDeLlamada.ts) aplica los
// efectos en Bitrix y persiste el estado.

export type Transicion = {
  /** Estado destino del target. En escalamiento, el ejecutor lo pasa a ESCALADO tras los side-effects. */
  status: CampaignStatus;
  /** true = aplicar el paquete de escalamiento (mover etapa + asignar asesor + tarea + resumen). */
  escalar: boolean;
};

/**
 * Estado siguiente del Deal tras clasificar el cierre de una llamada.
 * @param attemptsTotal intentos YA realizados (incluye el que acaba de terminar).
 * @param cierre resultado clasificado (determinístico o IA).
 * @param maxTotal tope de intentos del programa (agenda.maxTotal, típico 9).
 * @param optOut true si el prospecto pidió expresamente no ser contactado (terminal inmediato).
 */
export function siguienteEstado(
  attemptsTotal: number,
  cierre: Cierre,
  maxTotal: number,
  optOut = false,
): Transicion {
  if (optOut) return { status: 'NO_INTERESADO', escalar: false };

  switch (cierre.siguienteAccion) {
    case 'escalar':
      return { status: 'CALIFICADO', escalar: true };
    case 'callback':
      return { status: 'CALLBACK', escalar: false };
    case 'nurture':
      return { status: 'SEGUIMIENTO', escalar: false };
    case 'cerrar':
      return {
        status: cierre.clasificacion === 'Número incorrecto' ? 'NUMERO_INVALIDO' : 'NO_INTERESADO',
        escalar: false,
      };
    case 'reintentar':
    default:
      if (cierre.clasificacion === 'No es el titular') return { status: 'NO_TITULAR', escalar: false };
      // No contesta / error técnico → reintentar si quedan intentos; si no, agotado (→ recuperación WhatsApp).
      return { status: attemptsTotal >= maxTotal ? 'AGOTADO' : 'SIN_RESPUESTA', escalar: false };
  }
}
