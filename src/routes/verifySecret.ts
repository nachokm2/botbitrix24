import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { config } from '../config';
import { log } from '../log';

/** Comparación de secretos en tiempo constante (evita timing attacks). */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * Middleware que exige un secreto compartido (config.vapiSecret) en un header dado,
 * con comparación en tiempo constante.
 * Fail-closed en producción: si el secreto NO está configurado, rechaza con 503
 * en vez de dejar pasar. En desarrollo (NODE_ENV != 'production') deja pasar con aviso,
 * para no romper el flujo local mientras no haya secreto.
 */
export function verifyHeaderSecret(headerName: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const expected = config.vapiSecret;
    if (!expected) {
      if (process.env.NODE_ENV === 'production') {
        return res.status(503).json({ ok: false, error: 'secret no configurado (define VAPI_SECRET)' });
      }
      log.warn(`verify ${headerName}: sin VAPI_SECRET (fail-open solo en desarrollo)`);
      return next();
    }
    const given = req.header(headerName) ?? '';
    if (!safeEqual(given, expected)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    next();
  };
}
