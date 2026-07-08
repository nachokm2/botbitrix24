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
 * Fábrica de middleware que exige un token (en un header o query param), comparado en tiempo constante.
 * Fail-closed en producción: si el token NO está configurado, rechaza con 503 en vez de dejar pasar.
 * En desarrollo (NODE_ENV != 'production') deja pasar con aviso para no bloquear el trabajo local.
 */
function tokenGuard(getExpected: () => string, headerName: string, queryName: string, label: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const expected = getExpected();
    if (!expected) {
      if (process.env.NODE_ENV === 'production') {
        return res.status(503).json({ ok: false, error: `${label} no configurado` });
      }
      log.warn(`${label}: sin token configurado (fail-open solo en desarrollo)`);
      return next();
    }
    const given = req.header(headerName) ?? String((req.query as Record<string, unknown>)[queryName] ?? '');
    if (!safeEqual(given, expected)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    next();
  };
}

/** Protege los paneles embebidos y sus APIs de datos. El placement propaga el token vía `?k=`. */
export const requireDashboardToken = tokenGuard(() => config.dashboardToken, 'x-dashboard-token', 'k', 'DASHBOARD_TOKEN');

/** Protege las utilidades administrativas (/setup/*). Token por header `x-admin-token` o `?token=`. */
export const requireAdminToken = tokenGuard(() => config.adminToken, 'x-admin-token', 'token', 'ADMIN_TOKEN');
