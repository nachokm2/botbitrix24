import type { CampaignAgenda } from './programRegistry';

// ── Fase 4: calendario de la campaña (TZ Chile con DST) ──
// Usa Intl con timeZone IANA ('America/Santiago') → hora de pared correcta con horario de verano/invierno,
// sin librerías. PURO: sin I/O, testeable. El scheduler tickea cada minuto y consulta estos helpers.

export type Reloj = { y: number; mo: number; d: number; hh: number; mm: number; dow: number; ymd: string };

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Hora de pared (fecha/hora/día de semana) de un instante en la TZ dada. */
export function wallClock(now: Date, tz: string): Reloj {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(now);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const hh = g('hour') === '24' ? 0 : Number(g('hour')); // Intl puede devolver '24' a medianoche
  return {
    y: Number(g('year')), mo: Number(g('month')), d: Number(g('day')),
    hh, mm: Number(g('minute')), dow: DOW[g('weekday')] ?? 0,
    ymd: `${g('year')}-${g('month')}-${g('day')}`,
  };
}

/** Offset (ms) de la TZ en un instante: (hora de pared interpretada como UTC) − (instante real UTC). */
function tzOffsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(at);
  const m: Record<string, string> = {};
  for (const p of parts) m[p.type] = p.value;
  const hh = m.hour === '24' ? 0 : Number(m.hour);
  const asUtc = Date.UTC(Number(m.year), Number(m.month) - 1, Number(m.day), hh, Number(m.minute), Number(m.second));
  return asUtc - at.getTime();
}

/** Convierte una hora de pared en la TZ (y-mo-d hh:mm) al instante UTC correspondiente (Date). */
export function zonedToUtc(y: number, mo: number, d: number, hh: number, mm: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, hh, mm);
  const off = tzOffsetMs(new Date(guess), tz);
  return new Date(guess - off);
}

/** ¿La fecha (YYYY-MM-DD) es día hábil? (día de semana permitido y no feriado). */
export function esDiaHabil(ymd: string, dow: number, agenda: CampaignAgenda): boolean {
  return agenda.diasHabiles.includes(dow) && !agenda.feriados.includes(ymd);
}

/** Devuelve el slot de ola ('W1'|'W2'|…) si la hora de pared coincide EXACTO con una ola; si no, null. */
export function olaActual(hh: number, mm: number, waves: string[]): string | null {
  const hhmm = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  const idx = waves.indexOf(hhmm);
  return idx >= 0 ? `W${idx + 1}` : null;
}

/** ¿La hora de pared (hh:mm) está dentro de la ventana hábil [ini, fin]? */
export function dentroDeVentana(hh: number, mm: number, ventana: [string, string]): boolean {
  const min = hh * 60 + mm;
  const [ih, im] = ventana[0].split(':').map(Number);
  const [fh, fm] = ventana[1].split(':').map(Number);
  return min >= ih * 60 + im && min <= fh * 60 + fm;
}
