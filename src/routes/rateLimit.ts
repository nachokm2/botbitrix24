import type { Request, Response, NextFunction } from 'express';
import { getRedisClient } from '../store/kv';
import { log } from '../log';

type Bucket = { count: number; resetAt: number };

// Cuenta atómica por ventana en Redis: INCR y, solo en la primera petición de la ventana, fija el
// vencimiento. Un único round-trip (EVAL) evita la carrera INCR→EXPIRE que dejaría claves sin TTL.
const WINDOW_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return c`;

/**
 * Rate limiter por clave (IP por defecto), con ventana fija.
 * - Con Redis (producción): el conteo es COMPARTIDO entre réplicas → el límite es global, no por proceso.
 * - Sin Redis (dev/test): cae a un contador en memoria del proceso (comportamiento previo).
 * Fail-open ante un fallo transitorio de Redis: se deja pasar antes que bloquear tráfico legítimo.
 */
export function rateLimit(opts: { windowMs: number; max: number; name: string; key?: (req: Request) => string }) {
  // Estado en memoria (solo se usa en modo sin Redis; en producción queda inerte).
  const buckets = new Map<string, Bucket>();
  setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.resetAt < now) buckets.delete(k);
  }, opts.windowMs).unref();

  const tooMany = (res: Response) => {
    res.set('Retry-After', String(Math.ceil(opts.windowMs / 1000)));
    return res.status(429).json({ ok: false, error: 'rate limit' });
  };

  return async (req: Request, res: Response, next: NextFunction) => {
    const k = opts.key ? opts.key(req) : (req.ip ?? 'global');
    const redis = getRedisClient();

    if (redis) {
      try {
        const count = (await redis.eval(WINDOW_SCRIPT, 1, `rl:${opts.name}:${k}`, String(opts.windowMs))) as number;
        if (count > opts.max) return tooMany(res);
        return next();
      } catch (e) {
        // Fail-open: un blip de Redis no debe tumbar el tráfico. Se registra y se deja pasar.
        log.warn('rateLimit: Redis falló (fail-open)', { name: opts.name, err: String(e) });
        return next();
      }
    }

    // Fallback en memoria (dev/test).
    const now = Date.now();
    let b = buckets.get(k);
    if (!b || b.resetAt < now) {
      b = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(k, b);
    }
    b.count++;
    if (b.count > opts.max) return tooMany(res);
    next();
  };
}
