import type { Request, Response } from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { snapshot } from '../obs/metrics';
import { dbMetricsSummary, dbRecentAudit, dbEnabled } from '../store/db';
import { kvKind } from '../store/kv';
import { getState } from '../store';
import { getUsuarios } from '../crm/directory';
import { config } from '../config';

const RANGES = ['today', '7d', '30d', 'all'];

/** JSON con métricas de negocio (persistentes) + técnicas (en memoria) + actividad reciente. */
export async function metricsSummary(req: Request, res: Response) {
  const range = RANGES.includes(String(req.query.range)) ? String(req.query.range) : '7d';
  const [live, agg, recent] = await Promise.all([snapshot(), dbMetricsSummary(range), dbRecentAudit(15)]);

  // Resuelve el nombre de cada asesor responsable (por su ASSIGNED_BY_ID) para el desglose "Por asesor".
  if (agg?.porAsesor?.length) {
    const st = await getState();
    if (st.auth) {
      try {
        const ids = agg.porAsesor.map((r: any) => Number(r.id)).filter((n: number) => n > 0);
        const usuarios = await getUsuarios(ids, st.auth);
        const byId = new Map(usuarios.map((u) => [u.id, u.nombre]));
        agg.porAsesor = agg.porAsesor.map((r: any) => ({ ...r, nombre: byId.get(Number(r.id)) ?? `Asesor ${r.id}` }));
      } catch {
        /* deja los IDs si no se pueden resolver nombres */
      }
    }
  }

  const tin = Number(live.counters['tokens_in'] || 0);
  const tout = Number(live.counters['tokens_out'] || 0);
  const cost =
    config.costInPerMtok > 0 || config.costOutPerMtok > 0
      ? Number(((tin / 1e6) * config.costInPerMtok + (tout / 1e6) * config.costOutPerMtok).toFixed(2))
      : null;

  res.json({
    ok: true,
    range,
    kv: kvKind,
    db: dbEnabled() ? 'postgres' : 'off',
    startedAt: live.startedAt,
    live: { counters: live.counters, llm: live.llm },
    tokens: { in: tin, out: tout, costUsd: cost },
    agg,
    recent,
    funnelLabels: config.funnelLabels,
  });
}

/** Página del panel (se embebe dentro de Bitrix24 vía placement, y también funciona standalone).
 *  El HTML/CSS/JS viven en archivos estáticos (public/dashboard/) — ver ALT-Baja-7 de la auditoría. */
export function dashboardPage(_req: Request, res: Response) {
  res.set('Content-Type', 'text/html; charset=utf-8').send(DASHBOARD_HTML);
}

const DASHBOARD_HTML = readFileSync(fileURLToPath(new URL('../../public/dashboard/index.html', import.meta.url)), 'utf8');
