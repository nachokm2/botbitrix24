import Bottleneck from 'bottleneck';
import { config } from '../config';
import type { Auth } from '../store';
import { refreshAuth } from './refresh';

// Throttle = leaky bucket de Bitrix (2 req/s, ráfaga 50, 2 concurrentes) en planes no-Enterprise.
const limiter = new Bottleneck({
  reservoir: 50,
  reservoirRefreshAmount: 2,
  reservoirRefreshInterval: 1000,
  maxConcurrent: 2,
});

/** Sobre de respuesta de Bitrix: result + paginación (next/total) cuando aplica (métodos .list/.get de estadística). */
export type BitrixEnvelope<T = any> = { result: T; next?: number; total?: number };

/** Llamada REST autenticada por OAuth. Si el token expiró, lo renueva una vez y reintenta. */
export async function callBitrix<T = any>(
  method: string,
  params: Record<string, unknown>,
  auth: Auth,
): Promise<T> {
  const json = await limiter.schedule(() => doCall(method, params, auth, false));
  return json.result as T;
}

/** Igual que callBitrix pero devuelve el sobre completo (result + next + total) para paginar. */
export async function callBitrixEnvelope<T = any>(
  method: string,
  params: Record<string, unknown>,
  auth: Auth,
): Promise<BitrixEnvelope<T>> {
  const json = await limiter.schedule(() => doCall(method, params, auth, false));
  return { result: json.result, next: json.next, total: json.total };
}

/** POST JSON con reintentos ante errores transitorios (429 / 5xx / respuesta no-JSON de gateway). */
async function postJsonWithRetry(url: string, body: unknown, attempt = 0): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    const wait = Math.min(2000 * 2 ** attempt, 8000) + Math.random() * 250;
    await new Promise((r) => setTimeout(r, wait));
    return postJsonWithRetry(url, body, attempt + 1);
  }
  try {
    return await res.json();
  } catch {
    throw new Error(`Bitrix HTTP ${res.status}: respuesta no-JSON`);
  }
}

async function doCall(
  method: string,
  params: Record<string, unknown>,
  auth: Auth,
  retried: boolean,
  qlRetry = 0,
): Promise<any> {
  const json: any = await postJsonWithRetry(`https://${auth.domain}/rest/${method}`, {
    ...params,
    auth: auth.access_token,
  });
  if (json.error) {
    const err = String(json.error);
    const expired = err === 'expired_token' || err === 'invalid_token';
    if (expired && !retried && auth.refresh_token) {
      const fresh = await refreshAuth(auth); // renueva on-demand y persiste (single-flight)
      return doCall(method, params, fresh, true, qlRetry);
    }
    if (err === 'QUERY_LIMIT_EXCEEDED' && qlRetry < 2) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** qlRetry));
      return doCall(method, params, auth, retried, qlRetry + 1);
    }
    throw new Error(`Bitrix ${method}: ${json.error} ${json.error_description ?? ''}`);
  }
  return json; // sobre completo (result + next + total)
}

/** Petición cruda al webhook entrante; devuelve el sobre completo (result + next + total). */
async function webhookRaw(method: string, params: Record<string, unknown>, webhookUrl: string): Promise<any> {
  const url = `${webhookUrl.replace(/\/$/, '')}/${method}`;
  const json: any = await postJsonWithRetry(url, params);
  if (json.error) {
    throw new Error(`Bitrix ${method}: ${json.error} ${json.error_description ?? ''}`);
  }
  return json;
}

/** Llamada vía webhook entrante (sin OAuth) — solo para smoke rápido. */
export async function callWebhook<T = any>(
  method: string,
  params: Record<string, unknown>,
  webhookUrl: string,
): Promise<T> {
  return (await webhookRaw(method, params, webhookUrl)).result as T;
}

/** Como callCrm, pero devuelve result + next + total (para paginar voximplant.statistic.get, crm.*.list, etc.). */
export async function callCrmEnvelope<T = any>(
  method: string,
  params: Record<string, unknown>,
  auth: Auth,
): Promise<BitrixEnvelope<T>> {
  if (config.bitrixWebhookUrl) {
    const json = await webhookRaw(method, params, config.bitrixWebhookUrl);
    return { result: json.result, next: json.next, total: json.total };
  }
  return callBitrixEnvelope<T>(method, params, auth);
}

/**
 * Llamadas CRM: usa el webhook entrante (admin, permisos completos) si está configurado;
 * si no, el token del evento/app. El token del bot es no-Intranet y tiene CRM limitado,
 * por eso las escrituras al CRM se canalizan por el webhook cuando existe.
 */
export async function callCrm<T = any>(method: string, params: Record<string, unknown>, auth: Auth): Promise<T> {
  if (config.bitrixWebhookUrl) return callWebhook<T>(method, params, config.bitrixWebhookUrl);
  return callBitrix<T>(method, params, auth);
}
