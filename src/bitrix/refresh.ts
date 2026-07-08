import { config } from '../config';
import { setAuth, type Auth } from '../store';

/**
 * Renueva el access_token usando el refresh_token (válido 180 días).
 * Endpoint OAuth de Bitrix24: https://oauth.bitrix.info/oauth/token/
 * Persiste el nuevo par de tokens en el store.
 */
// Single-flight: si ya hay un refresh en curso para el mismo portal, reutiliza esa promesa.
// Evita grants paralelos que rotan el refresh_token y se invalidan entre sí (corrompiendo el estado).
const inFlight = new Map<string, Promise<Auth>>();

export function refreshAuth(auth: Auth): Promise<Auth> {
  const key = auth.member_id || auth.domain || 'default';
  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = doRefresh(auth).finally(() => {
    if (inFlight.get(key) === p) inFlight.delete(key);
  });
  inFlight.set(key, p);
  return p;
}

async function doRefresh(auth: Auth): Promise<Auth> {
  if (!auth.refresh_token) {
    throw new Error('No hay refresh_token para renovar el access_token.');
  }
  if (!config.bitrixClientId || !config.bitrixClientSecret) {
    throw new Error('Faltan BITRIX_CLIENT_ID / BITRIX_CLIENT_SECRET para renovar el token.');
  }

  const url = new URL('https://oauth.bitrix.info/oauth/token/');
  url.searchParams.set('grant_type', 'refresh_token');
  url.searchParams.set('client_id', config.bitrixClientId);
  url.searchParams.set('client_secret', config.bitrixClientSecret);
  url.searchParams.set('refresh_token', auth.refresh_token);

  const res = await fetch(url, { method: 'GET' });
  const j: any = await res.json();
  if (j.error) {
    throw new Error(`OAuth refresh: ${j.error} ${j.error_description ?? ''}`);
  }

  const updated: Auth = {
    domain: auth.domain || j.domain || '',
    access_token: j.access_token,
    refresh_token: j.refresh_token ?? auth.refresh_token,
    member_id: j.member_id ?? auth.member_id,
    expires: j.expires ? Number(j.expires) : undefined,
  };
  await setAuth(updated);
  return updated;
}
