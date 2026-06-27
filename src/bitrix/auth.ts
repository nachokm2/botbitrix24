import type { Request } from 'express';
import type { Auth } from '../store';

/**
 * Extrae las credenciales OAuth de Bitrix24 desde:
 *  - la instalación del app local (iframe): campos AUTH_ID / REFRESH_ID + ?DOMAIN
 *  - el payload de un evento: objeto auth[...]
 */
export function extractAuth(req: Request): Auth | null {
  const b: any = req.body ?? {};
  const q: any = req.query ?? {};

  // Instalación del app local (iframe)
  if (b.AUTH_ID) {
    return {
      access_token: b.AUTH_ID,
      refresh_token: b.REFRESH_ID,
      domain: q.DOMAIN || b.DOMAIN || '',
      member_id: b.member_id,
    };
  }

  // Payload de evento (ONIMBOTMESSAGEADD, ONAPPINSTALL, etc.)
  if (b.auth?.access_token) {
    return {
      access_token: b.auth.access_token,
      refresh_token: b.auth.refresh_token,
      domain: b.auth.domain || hostFrom(b.auth.client_endpoint) || hostFrom(b.auth.server_endpoint),
      member_id: b.auth.member_id,
      expires: b.auth.expires ? Number(b.auth.expires) : undefined,
    };
  }

  return null;
}

function hostFrom(endpoint?: string): string {
  if (!endpoint) return '';
  try {
    return new URL(endpoint).host;
  } catch {
    return '';
  }
}
