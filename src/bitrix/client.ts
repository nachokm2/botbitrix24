import Bottleneck from 'bottleneck';
import type { Auth } from '../store';

// Throttle = leaky bucket de Bitrix (2 req/s, ráfaga 50, 2 concurrentes) en planes no-Enterprise.
const limiter = new Bottleneck({
  reservoir: 50,
  reservoirRefreshAmount: 2,
  reservoirRefreshInterval: 1000,
  maxConcurrent: 2,
});

/** Llamada REST autenticada por OAuth (usa el access_token del evento o el almacenado). */
export async function callBitrix<T = any>(
  method: string,
  params: Record<string, unknown>,
  auth: Auth,
): Promise<T> {
  return limiter.schedule(async () => {
    const url = `https://${auth.domain}/rest/${method}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...params, auth: auth.access_token }),
    });
    const json: any = await res.json();
    if (json.error) {
      throw new Error(`Bitrix ${method}: ${json.error} ${json.error_description ?? ''}`);
    }
    return json.result as T;
  });
}

/** Llamada vía webhook entrante (sin OAuth) — solo para smoke rápido. */
export async function callWebhook<T = any>(
  method: string,
  params: Record<string, unknown>,
  webhookUrl: string,
): Promise<T> {
  const url = `${webhookUrl.replace(/\/$/, '')}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const json: any = await res.json();
  if (json.error) {
    throw new Error(`Bitrix ${method}: ${json.error} ${json.error_description ?? ''}`);
  }
  return json.result as T;
}
