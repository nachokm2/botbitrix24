import { config } from '../config';
import { setAuth, type Auth } from '../store';
import type { BitrixOAuthTokenResponse } from './types';

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
  const j = (await res.json()) as BitrixOAuthTokenResponse;
  if (j.error) {
    throw new Error(`OAuth refresh: ${j.error} ${j.error_description ?? ''}`);
  }

  const updated: Auth = {
    domain: auth.domain || j.domain || '',
    access_token: j.access_token ?? auth.access_token,
    refresh_token: j.refresh_token ?? auth.refresh_token,
    member_id: j.member_id ?? auth.member_id,
    expires: j.expires ? Number(j.expires) : undefined,
  };
  await setAuth(updated);
  return updated;
}

/**
 * Canjea un `code` de OAuth por el par de tokens (grant_type=authorization_code).
 *
 * Existe porque la instalación normal de un app local depende de que Bitrix abra la ruta de
 * instalación en un iframe del navegador y nos haga POST con AUTH_ID. En el portal de Carver eso
 * no ocurrió nunca: Bitrix respondía "Aplicación reinstalada" sin llegar a llamar la URL (0
 * peticiones al servidor, auth sin guardar). Este camino no depende de ese iframe — la persona abre
 * la URL de autorización, aprueba, y Bitrix redirige acá con el código.
 */
export async function exchangeCode(code: string, redirectUri?: string): Promise<Auth> {
  if (!config.bitrixClientId || !config.bitrixClientSecret) {
    throw new Error('Faltan BITRIX_CLIENT_ID / BITRIX_CLIENT_SECRET para canjear el código.');
  }
  const url = new URL('https://oauth.bitrix.info/oauth/token/');
  url.searchParams.set('grant_type', 'authorization_code');
  url.searchParams.set('client_id', config.bitrixClientId);
  url.searchParams.set('client_secret', config.bitrixClientSecret);
  url.searchParams.set('code', code);
  if (redirectUri) url.searchParams.set('redirect_uri', redirectUri);

  const res = await fetch(url, { method: 'GET' });
  const j = (await res.json()) as BitrixOAuthTokenResponse;
  if (j.error) throw new Error(`OAuth code: ${j.error} ${j.error_description ?? ''}`);
  if (!j.access_token) throw new Error('OAuth code: la respuesta no trajo access_token.');

  // El dominio sale de client_endpoint, NO de j.domain: en el grant por código ese campo trae
  // "oauth.bitrix.info" (el servidor de OAuth). Guardarlo tal cual mandaba todas las llamadas REST a
  // ese host, donde ningún método del portal existe: imbot.register respondía ERROR_METHOD_NOT_FOUND.
  const portal = hostDe(j.client_endpoint) || hostDe(j.server_endpoint) || j.domain || '';
  const auth: Auth = {
    domain: portal,
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    member_id: j.member_id,
    expires: j.expires ? Number(j.expires) : undefined,
  };
  await setAuth(auth);
  return auth;
}

function hostDe(endpoint?: string): string {
  if (!endpoint) return '';
  try {
    return new URL(endpoint).host;
  } catch {
    return '';
  }
}
