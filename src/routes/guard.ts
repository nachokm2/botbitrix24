import type { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { log } from '../log';
import { safeEqual } from '../util/crypto';

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

/** Origin de un header Referer (p. ej. "https://x.com/pagina" → "https://x.com"), o '' si no es una URL válida. */
function originOfReferer(referer: string): string {
  try {
    return new URL(referer).origin;
  } catch {
    return '';
  }
}

/**
 * Restringe un endpoint público (p. ej. /webchat/message) a un allowlist de orígenes (config.webchatAllowedOrigins),
 * como defensa adicional al rate-limit contra abuso desde sitios no autorizados (ver ALT-Alta-2 de la auditoría).
 * Si el allowlist está vacío (sin BASE_URL ni WEBCHAT_ALLOWED_ORIGINS configurados), no restringe: comportamiento
 * previo sin cambios. Esto NO es una barrera de seguridad fuerte (un cliente no-navegador puede falsear el header
 * Origin), es defensa en profundidad contra el abuso casual desde otros sitios vía navegador.
 */
export function requireAllowedOrigin(req: Request, res: Response, next: NextFunction) {
  const allowed = config.webchatAllowedOrigins;
  if (!allowed.length) return next();
  const referer = req.header('referer') ?? '';
  const origin = req.header('origin') || (referer ? originOfReferer(referer) : '');
  if (!origin || !allowed.includes(origin)) {
    log.warn('requireAllowedOrigin: origen no permitido', { origin: origin || '(sin header)' });
    return res.status(403).json({ ok: false, error: 'origen no permitido' });
  }
  next();
}
