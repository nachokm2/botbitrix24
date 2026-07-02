import pg from 'pg';
import { config } from '../config';
import { log } from '../log';

// Auditoría persistente en Postgres (si hay DATABASE_URL). Si no, no-op (solo logs).
let pool: pg.Pool | null = null;

export type AuditEntry = {
  type: string;
  dialogId?: string;
  crmEntity?: string;
  detail?: unknown;
};

export async function initDb(): Promise<void> {
  if (!config.databaseUrl) {
    log.info('DB: sin DATABASE_URL → auditoría solo en logs');
    return;
  }
  try {
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      ssl: config.pgSsl ? { rejectUnauthorized: false } : undefined,
      max: 4,
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id BIGSERIAL PRIMARY KEY,
        ts TIMESTAMPTZ NOT NULL DEFAULT now(),
        type TEXT NOT NULL,
        dialog_id TEXT,
        crm_entity TEXT,
        detail JSONB
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS audit_log_ts_idx ON audit_log (ts DESC);`);
    log.info('DB: Postgres conectado y tabla audit_log lista');
  } catch (e) {
    log.error('DB: init falló, auditoría solo en logs', { err: String(e) });
    pool = null;
  }
}

export async function dbInsertAudit(e: AuditEntry): Promise<void> {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO audit_log (type, dialog_id, crm_entity, detail) VALUES ($1,$2,$3,$4)`,
      [e.type, e.dialogId ?? null, e.crmEntity ?? null, e.detail ? JSON.stringify(e.detail) : null],
    );
  } catch (err) {
    log.warn('dbInsertAudit falló', { err: String(err) });
  }
}

export async function dbRecentAudit(limit = 20): Promise<any[]> {
  if (!pool) return [];
  try {
    const r = await pool.query(
      `SELECT ts, type, dialog_id, crm_entity, detail FROM audit_log ORDER BY ts DESC LIMIT $1`,
      [limit],
    );
    return r.rows;
  } catch (err) {
    log.warn('dbRecentAudit falló', { err: String(err) });
    return [];
  }
}

export function dbEnabled(): boolean {
  return pool !== null;
}

// Intervalos permitidos (whitelist, para evitar inyección en el SQL).
const RANGE_INTERVAL: Record<string, string | null> = {
  today: '1 day',
  '7d': '7 days',
  '30d': '30 days',
  all: null,
};

/** Agregaciones de negocio desde audit_log (persistentes), filtradas por rango. null si no hay Postgres. */
export async function dbMetricsSummary(range = '7d'): Promise<Record<string, any> | null> {
  if (!pool) return null;
  const p = pool;
  const interval = range in RANGE_INTERVAL ? RANGE_INTERVAL[range] : '7 days';
  const W = interval ? `AND ts >= now() - interval '${interval}'` : ''; // interval viene de whitelist
  const q = (sql: string) => p.query(sql);
  try {
    const [byType, conv, tools, leadsOk, scoreAgg, intenc, sentim, perDay, embudo] = await Promise.all([
      q(`SELECT type, count(*)::int c FROM audit_log WHERE true ${W} GROUP BY type`),
      q(`SELECT count(DISTINCT dialog_id)::int c FROM audit_log WHERE dialog_id IS NOT NULL ${W}`),
      q(`SELECT detail->>'name' name, count(*)::int c FROM audit_log WHERE type='tool_call' ${W} GROUP BY 1`),
      q(`SELECT count(*)::int c FROM audit_log WHERE type='tool_call' AND detail->>'name'='registrar_interes_crm' AND detail->>'ok'='true' ${W}`),
      q(`SELECT round(avg((detail->>'score')::numeric))::int avg, count(*)::int c FROM audit_log WHERE type='lead_score' AND detail->>'score' IS NOT NULL ${W}`),
      q(`SELECT detail->>'intencion' k, count(*)::int c FROM audit_log WHERE type='lead_score' AND detail->>'intencion' IS NOT NULL ${W} GROUP BY 1`),
      q(`SELECT detail->>'sentimiento' k, count(*)::int c FROM audit_log WHERE type='lead_score' AND detail->>'sentimiento' IS NOT NULL ${W} GROUP BY 1`),
      q(`SELECT to_char(date_trunc('day', ts),'YYYY-MM-DD') d, count(*)::int c FROM audit_log WHERE type='turn' AND ts >= now() - interval '7 days' GROUP BY 1 ORDER BY 1`),
      q(`SELECT detail->>'categoryId' cat, count(*)::int c, round(avg((detail->>'score')::numeric))::int avg
         FROM audit_log WHERE type='lead_score' AND detail->>'categoryId' IS NOT NULL ${W} GROUP BY 1 ORDER BY 2 DESC`),
    ]);
    const map = (rows: any[], k: string, v = 'c') =>
      Object.fromEntries(rows.filter((r) => r[k] != null).map((r) => [r[k], r[v]]));
    const byTypeMap = map(byType.rows, 'type');
    const toolMap = map(tools.rows, 'name');
    return {
      conversaciones: conv.rows[0]?.c ?? 0,
      turnos: byTypeMap['turn'] ?? 0,
      tools: toolMap,
      leadsCapturados: leadsOk.rows[0]?.c ?? 0,
      escalamientos: (byTypeMap['auto_escalation'] ?? 0) + (toolMap['escalar_a_humano'] ?? 0),
      etapasMovidas: byTypeMap['stage_move'] ?? 0,
      scoreAvg: scoreAgg.rows[0]?.avg ?? null,
      scoreCount: scoreAgg.rows[0]?.c ?? 0,
      intencion: map(intenc.rows, 'k'),
      sentimiento: map(sentim.rows, 'k'),
      porDia: perDay.rows,
      porEmbudo: embudo.rows, // [{cat, c, avg}]
      byType: byTypeMap,
    };
  } catch (e) {
    log.warn('dbMetricsSummary falló', { err: String(e) });
    return null;
  }
}
