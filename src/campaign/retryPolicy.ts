import type { CampaignAgenda } from './programRegistry';
import type { CampaignTarget } from './types';

// ── Fase 4: política de reintentos (3/día, 3 días, 9 total) ──
// PURA: decide, al momento de una ola, si se debe llamar a un target y cómo quedan sus contadores.
// El orquestador aplica el patch y dispara la llamada. Separa la regla de negocio del I/O (testeable).

export type PlanIntento = {
  /** true = llamar ahora en esta ola. */
  llamar: boolean;
  /** true = ya no quedan intentos/días → pasar a AGOTADO (recuperación WhatsApp en Fase 5). */
  agotado: boolean;
  /** Número del intento (1..maxTotal) si se llama. */
  attemptNo: number;
  /** Campos a persistir en campaign_target cuando se llama (contadores + estado LLAMANDO). */
  patch: Partial<CampaignTarget>;
};

/**
 * Decide el intento para un target en la ola actual (fecha `ymd` en hora local, `nowIso` = instante).
 * Reglas: máximo `maxPorDia` por día, `maxDias` días, `maxTotal` intentos. El day_index avanza al
 * cambiar de fecha; attempts_today se resetea por día. No llama si ya contestó/opt-out/etc. (eso lo
 * filtra la query dbDueCampaignTargets antes).
 */
export function planificarIntento(
  target: Pick<CampaignTarget, 'attemptsTotal' | 'attemptsToday' | 'dayIndex' | 'todayDate'>,
  agenda: CampaignAgenda,
  ymd: string,
  nowIso: string,
): PlanIntento {
  const attemptsTotal = target.attemptsTotal ?? 0;
  const nuevoDia = target.todayDate !== ymd;
  // day_index: 1 la primera vez; +1 cada nuevo día calendario con actividad.
  let dayIndex = target.dayIndex ?? 1;
  let attemptsToday = target.attemptsToday ?? 0;
  if (nuevoDia) {
    dayIndex = target.todayDate ? dayIndex + 1 : 1;
    attemptsToday = 0;
  }

  // Agotamiento: superó los días permitidos o el total de intentos.
  if (dayIndex > agenda.maxDias || attemptsTotal >= agenda.maxTotal) {
    return { llamar: false, agotado: true, attemptNo: 0, patch: {} };
  }
  // Tope diario: ya se hicieron los intentos de hoy → esperar a la próxima jornada (no agotado).
  if (attemptsToday >= agenda.maxPorDia) {
    return { llamar: false, agotado: false, attemptNo: 0, patch: {} };
  }

  const attemptNo = attemptsTotal + 1;
  return {
    llamar: true,
    agotado: false,
    attemptNo,
    patch: {
      status: 'LLAMANDO',
      dayIndex,
      attemptsToday: attemptsToday + 1,
      attemptsTotal: attemptNo,
      todayDate: ymd,
      lastAttemptAt: nowIso,
      nextAttemptAt: null,
    },
  };
}
