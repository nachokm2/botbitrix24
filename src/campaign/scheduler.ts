import { activePrograms } from './programRegistry';
import { wallClock, olaActual, esDiaHabil } from './calendar';
import { correrOla } from './orchestrator';
import { once } from '../store/kv';
import { getState, EMPTY_AUTH } from '../store';
import { log } from '../log';

// ── Fase 4: scheduler de olas ──
// Tick cada minuto: para cada programa ACTIVO, si la hora de pared (TZ del programa) coincide con una
// ola y es día hábil, dispara la ola — con lock distribuido `once` para que solo UNA réplica la corra.
// No hace nada si no hay programas activos (CAMPAIGN_*_ACTIVO=false) → seguro dejarlo cableado siempre.

export function startCampaignScheduler(): void {
  const activos = activePrograms();
  if (!activos.length) {
    log.info('scheduler campaña: sin programas activos (define CAMPAIGN_<code>_ACTIVO=true para encender)');
    return;
  }

  let corriendo = false; // evita solapes si un tick tarda más de 60s
  const tick = async () => {
    if (corriendo) return;
    corriendo = true;
    try {
      const now = new Date();
      for (const pc of activePrograms()) {
        const wc = wallClock(now, pc.agenda.tz);
        const ola = olaActual(wc.hh, wc.mm, pc.agenda.waves);
        if (!ola) continue;
        if (!esDiaHabil(wc.ymd, wc.dow, pc.agenda)) {
          log.info('scheduler campaña: ola en día no hábil, se omite', { programa: pc.code, ola, fecha: wc.ymd });
          continue;
        }
        // Una sola réplica dispara cada (programa, fecha, ola).
        if (!(await once(`lock:wave:${pc.code}:${wc.ymd}:${ola}`, 3600))) continue;

        const st = await getState();
        const auth = st.auth ?? EMPTY_AUTH;
        log.info('scheduler campaña: disparando ola', { programa: pc.code, ola, fecha: wc.ymd });
        const r = await correrOla(pc, now, ola, auth).catch((e) => {
          log.warn('scheduler campaña: correrOla falló', { programa: pc.code, ola, err: String(e) });
          return null;
        });
        if (r) log.info('scheduler campaña: ola completada', { programa: pc.code, ola, ...r });
      }
    } finally {
      corriendo = false;
    }
  };

  setInterval(() => void tick(), 60_000);
  log.info('scheduler campaña: activo', { programas: activos.map((p) => p.code) });
}
