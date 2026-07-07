import { callCrmEnvelope } from '../bitrix/client';
import { normalizeCall } from './callStats';
import { dbEnabled, dbUpsertCalls, dbCallsWatermarkIso } from '../store/db';
import { getState } from '../store';
import { config } from '../config';
import { log } from '../log';
import type { Auth } from '../store';

// Sincroniza voximplant.statistic.get → tabla `calls` en Postgres, de forma INCREMENTAL:
// usa la marca de agua (ISO de la última llamada guardada) y trae solo lo nuevo (con 1 min de solape).
// Primer arranque: backfill desde CALLS_SYNC_SINCE (o 90 días atrás). El upsert por id evita duplicados.

const MAX_PAGES = 2000; // tope de páginas por corrida (50k llamadas); la marca de agua reanuda en la siguiente
let syncing = false;

function backfillDefault(): string {
  return new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(); // últimos 30 días
}

/** Corre una sincronización. Devuelve cuántas llamadas se guardaron y desde cuándo. */
export async function syncCalls(auth: Auth): Promise<{ ok: boolean; synced?: number; since?: string; pages?: number; error?: string }> {
  if (!dbEnabled()) return { ok: false, error: 'Postgres desactivado (define DATABASE_URL).' };
  if (!config.bitrixWebhookUrl && !auth?.access_token) return { ok: false, error: 'Sin webhook ni auth OAuth.' };
  if (syncing) return { ok: false, error: 'Ya hay una sincronización en curso.' };
  syncing = true;
  try {
    const wm = await dbCallsWatermarkIso();
    // Marca de agua menos 1 min de solape; si no hay, backfill desde CALLS_SYNC_SINCE o 90 días.
    const since = wm ? new Date(new Date(wm).getTime() - 60_000).toISOString() : config.callsSyncSince || backfillDefault();

    let start = 0;
    let synced = 0;
    let pages = 0;
    for (; pages < MAX_PAGES; pages++) {
      const env = await callCrmEnvelope<any[]>(
        'voximplant.statistic.get',
        { FILTER: { '>=CALL_START_DATE': since }, SORT: 'CALL_START_DATE', ORDER: 'ASC', start },
        auth,
      );
      const batch = Array.isArray(env.result) ? env.result : [];
      if (!batch.length) break;
      synced += await dbUpsertCalls(batch.map(normalizeCall));
      if (env.next == null) break;
      start = env.next;
    }
    log.info('syncCalls OK', { synced, since, pages });
    return { ok: true, synced, since, pages };
  } catch (e) {
    log.warn('syncCalls falló', { err: String(e) });
    return { ok: false, error: String(e) };
  } finally {
    syncing = false;
  }
}

/** Arranca el scheduler periódico (si CALLS_SYNC_MINUTES>0 y hay Postgres). Corre una vez al inicio. */
export function startCallSync(): void {
  if (!dbEnabled() || config.callsSyncMinutes <= 0) {
    log.info('sync de llamadas: scheduler desactivado (usa /setup/sync-calls o define CALLS_SYNC_MINUTES).');
    return;
  }
  const run = async () => {
    const st = await getState();
    await syncCalls(st.auth ?? ({} as any));
  };
  setTimeout(run, 15_000); // primera corrida a los 15 s del arranque
  setInterval(run, config.callsSyncMinutes * 60_000);
  log.info('sync de llamadas: scheduler activo', { cadaMin: config.callsSyncMinutes });
}
