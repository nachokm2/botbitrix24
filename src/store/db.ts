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
