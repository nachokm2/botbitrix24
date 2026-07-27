import { getRedisClient, kvGet, kvSet } from '../store/kv';
import type { ProgramConfig } from './programRegistry';

// ── Fase 3: asignación de asesor ──
// Selecciona el asesor humano al que se escala/asigna un Deal calificado, según la estrategia del
// programa. El round-robin usa un contador persistente (Redis INCR si hay, si no KV en proceso).

/** Índice round-robin persistente por programa (monótono creciente). */
async function nextRoundRobinIndex(programCode: string): Promise<number> {
  const key = `rr:asesor:${programCode}`;
  const r = getRedisClient();
  if (r) {
    try {
      return (await r.incr(key)) - 1; // INCR atómico; -1 para que empiece en 0
    } catch {
      /* cae al KV en proceso */
    }
  }
  const cur = Number(await kvGet(key)) || 0;
  await kvSet(key, String(cur + 1));
  return cur;
}

/** Selección PURA del asesor en el pool dado un índice (round-robin testeable, tolerante a negativos). */
export function asesorEnIndice(pool: number[], index: number): number {
  if (!pool.length) return 0;
  return pool[((index % pool.length) + pool.length) % pool.length];
}

/**
 * Elige el asesor para un Deal según la estrategia del programa:
 *  - 'fixed': siempre fallbackUserId.
 *  - 'owner': el responsable actual del Deal (si lo hay); si no, round-robin.
 *  - 'round-robin' (default): reparte parejo entre el pool (fallback al fallbackUserId si el pool está vacío).
 * Devuelve 0 si no hay a quién asignar.
 */
export async function elegirAsesor(pc: ProgramConfig, dealResponsableId?: number): Promise<number> {
  const { estrategia, pool, fallbackUserId } = pc.asesor;
  if (estrategia === 'fixed') return fallbackUserId || 0;
  if (estrategia === 'owner' && dealResponsableId) return dealResponsableId;
  const efectivo = pool.length ? pool : fallbackUserId ? [fallbackUserId] : [];
  if (!efectivo.length) return fallbackUserId || 0;
  const idx = await nextRoundRobinIndex(pc.code);
  return asesorEnIndice(efectivo, idx);
}
