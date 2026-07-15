import type { Request, Response } from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getState, EMPTY_AUTH } from '../store';
import { config } from '../config';
import { getCallAnalytics, getCallAnalyticsFromDb, type CallFilters } from '../crm/callStats';
import { dbEnabled, dbHasCalls } from '../store/db';

const str = (v: unknown): string | undefined => {
  const s = String(v ?? '').trim();
  return s || undefined;
};

/** API JSON de analítica de llamadas (KPIs + series + tabla), con filtros por querystring. */
export async function callsData(req: Request, res: Response) {
  const st = await getState();
  const auth = st.auth ?? EMPTY_AUTH;
  if (!config.bitrixWebhookUrl && !st.auth) {
    return res.json({ ok: false, error: 'Sin credenciales: configura BITRIX_WEBHOOK_URL (scope telephony) o instala el app.' });
  }
  const q = req.query;
  const type = q.type === 'in' || q.type === 'out' ? (q.type as 'in' | 'out') : undefined;
  const status = q.status === 'answered' || q.status === 'missed' ? (q.status as 'answered' | 'missed') : undefined;
  const f: CallFilters = {
    from: str(q.from),
    to: str(q.to),
    userId: q.userId ? Number(q.userId) : undefined,
    type,
    status,
    phone: str(q.phone),
    limit: q.limit ? Number(q.limit) : undefined,
  };
  try {
    // Si hay Postgres con llamadas sincronizadas → KPIs exactos del período; si no, muestra en vivo (REST).
    const useDb = dbEnabled() && (await dbHasCalls());
    const data = useDb ? await getCallAnalyticsFromDb(f, auth) : await getCallAnalytics(f, auth);
    res.json({ ok: true, ...data });
  } catch (e) {
    res.json({ ok: false, error: String(e) });
  }
}

/** Página de analítica de llamadas (embebible en Bitrix24 vía placement).
 *  El HTML/CSS/JS viven en archivos estáticos (public/calls/) — ver ALT-Baja-7 de la auditoría. */
export function callsPage(_req: Request, res: Response) {
  res.set('Content-Type', 'text/html; charset=utf-8').send(CALLS_HTML);
}

const CALLS_HTML = readFileSync(fileURLToPath(new URL('../../public/calls/index.html', import.meta.url)), 'utf8');
