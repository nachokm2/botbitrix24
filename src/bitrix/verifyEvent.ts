import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { config } from '../config';
import { getState } from '../store';
import { log } from '../log';

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * Verifica el `application_token` que Bitrix envía en cada evento (prueba de origen del webhook).
 * Valor esperado: BITRIX_APPLICATION_TOKEN (env) o el token capturado en la instalación (persistido en KV).
 * Fail-closed en producción; en desarrollo deja pasar con aviso.
 */
export function verifyBitrixEvent(req: Request, res: Response, next: NextFunction) {
  void (async () => {
    const body = (req.body as Record<string, any>) ?? {};
    const got = String(body?.auth?.application_token ?? body?.application_token ?? '');
    const expected = config.bitrixAppToken || (await getState()).appToken || '';
    if (!expected) {
      if (process.env.NODE_ENV === 'production') {
        return res.status(503).json({ error: 'application_token no configurado' });
      }
      log.warn('verifyBitrixEvent: sin application_token (fail-open solo en desarrollo)');
      return next();
    }
    if (!safeEqual(got, expected)) return res.status(401).json({ error: 'unauthorized' });
    next();
  })().catch((e) => {
    log.error('verifyBitrixEvent error', { err: String(e) });
    res.status(500).json({ error: 'verify_error' });
  });
}
