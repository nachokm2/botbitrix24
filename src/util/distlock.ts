import crypto from 'crypto';
import type Redis from 'ioredis';
import { getRedisClient } from '../store/kv';
import { createKeyedLock } from './concurrency';
import { log } from '../log';

// Lock por clave que funciona ENTRE réplicas.
// - Con Redis (producción): SET NX PX con un token único; se libera con un Lua compare-and-del
//   (solo borra si el token sigue siendo nuestro → nunca liberamos el lock de otro tras un timeout).
// - Sin Redis (dev/test): usa el lock in-process (createKeyedLock), que encadena por clave sin polling.
//
// Motivación (auditoría §4): dos réplicas procesando el MISMO diálogo a la vez provocan carreras
// read-modify-write sobre historial/sesión en Redis. El lock in-process anterior no cruzaba réplicas.

const memLock = createKeyedLock();

// Devuelve 1 si borró (era nuestro token), 0 si no. Evita liberar un lock que ya expiró y re-adquirió otro.
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type LockOpts = {
  /** TTL del lock. Debe superar la duración típica de un turno. Default 120s. */
  ttlMs?: number;
  /** Cuánto esperar para adquirir antes de proceder igual (fail-open). Default 15s. */
  waitMs?: number;
};

/** Ejecuta `fn` con exclusión mutua por `key` a través de todas las réplicas. */
export function withKeyedLock<T>(key: string, fn: () => Promise<T>, opts: LockOpts = {}): Promise<T> {
  const redis = getRedisClient();
  if (!redis) return memLock(key, fn);
  return withRedisLock(redis, key, fn, opts);
}

async function withRedisLock<T>(redis: Redis, key: string, fn: () => Promise<T>, opts: LockOpts): Promise<T> {
  const ttlMs = opts.ttlMs ?? 120_000;
  const waitMs = opts.waitMs ?? 15_000;
  const lockKey = `lock:dialog:${key}`;
  const token = crypto.randomUUID();
  const deadline = Date.now() + waitMs;

  let acquired = false;
  let delay = 50;
  while (Date.now() < deadline) {
    try {
      if ((await redis.set(lockKey, token, 'PX', ttlMs, 'NX')) === 'OK') {
        acquired = true;
        break;
      }
    } catch (e) {
      // Fail-open ante fallo de Redis: no dejamos caer el turno por no poder tomar el lock.
      log.warn('withKeyedLock: adquisición falló (fail-open, se procede sin lock)', { key, err: String(e) });
      return fn();
    }
    await sleep(Math.min(delay, 500) + Math.floor(Math.random() * 50));
    delay *= 2;
  }

  if (!acquired) {
    // Contención sostenida (>waitMs): procesamos igual para no perder el mensaje. Raro; se registra.
    log.warn('withKeyedLock: no se adquirió el lock dentro del plazo; se procede sin él', { key, waitMs });
    return fn();
  }

  try {
    return await fn();
  } finally {
    try {
      await redis.eval(RELEASE, 1, lockKey, token);
    } catch (e) {
      log.warn('withKeyedLock: liberación falló (expira solo por TTL)', { key, err: String(e) });
    }
  }
}
