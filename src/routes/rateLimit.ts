import type { Request, Response, NextFunction } from 'express';

type Bucket = { count: number; resetAt: number };

/**
 * Rate limiter simple en memoria (ventana fija por clave; IP por defecto). Es per-proceso:
 * suficiente como primera línea anti-abuso. Para multi-réplica, mover a un store compartido (Redis).
 */
export function rateLimit(opts: { windowMs: number; max: number; key?: (req: Request) => string }) {
  const buckets = new Map<string, Bucket>();
  setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.resetAt < now) buckets.delete(k);
  }, opts.windowMs).unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const k = opts.key ? opts.key(req) : (req.ip ?? 'global');
    const now = Date.now();
    let b = buckets.get(k);
    if (!b || b.resetAt < now) {
      b = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(k, b);
    }
    b.count++;
    if (b.count > opts.max) {
      res.set('Retry-After', String(Math.ceil((b.resetAt - now) / 1000)));
      return res.status(429).json({ ok: false, error: 'rate limit' });
    }
    next();
  };
}
