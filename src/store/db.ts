import pg from 'pg';
import { config } from '../config';
import { log } from '../log';
import type { NormCall, CallFilters, CallKpis } from '../crm/callStats';

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
    // Tabla de llamadas (espejo de voximplant.statistic.get) para KPIs exactos del período.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS calls (
        id TEXT PRIMARY KEY,
        ts TIMESTAMPTZ,
        iso TEXT,
        local_date DATE,
        hora SMALLINT,
        dow SMALLINT,
        tipo_code SMALLINT,
        is_outbound BOOLEAN,
        telefono TEXT,
        duracion INT,
        user_id INT,
        estado_code TEXT,
        contestada BOOLEAN,
        grabacion TEXT,
        crm_tipo TEXT,
        crm_id INT
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS calls_ts_idx ON calls (ts DESC);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS calls_local_date_idx ON calls (local_date);`);
    log.info('DB: Postgres conectado y tablas audit_log/calls listas');
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

// ─────────────────────────── Espejo de llamadas (analítica exacta) ───────────────────────────

const CALL_COLS = [
  'id', 'ts', 'iso', 'local_date', 'hora', 'dow', 'tipo_code', 'is_outbound',
  'telefono', 'duracion', 'user_id', 'estado_code', 'contestada', 'grabacion', 'crm_tipo', 'crm_id',
];

/** Inserta/actualiza (upsert por id) un lote de llamadas normalizadas. Devuelve cuántas se guardaron. */
export async function dbUpsertCalls(rows: NormCall[]): Promise<number> {
  if (!pool || !rows.length) return 0;
  const p = pool;
  const N = CALL_COLS.length;
  let done = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const vals: any[] = [];
    const tuples = chunk
      .map((n, k) => {
        const b = k * N;
        vals.push(
          n.id, n.iso || null, n.iso || null, n.localDate || null, n.hora, n.dow, n.tipoCode, n.isOutbound,
          n.telefono, n.duracion, n.usuarioId, n.estadoCode, n.contestada, n.grabacion, n.crmTipo || null, n.crmId || null,
        );
        return '(' + CALL_COLS.map((_, j) => '$' + (b + j + 1)).join(',') + ')';
      })
      .join(',');
    const upd = CALL_COLS.slice(1).map((c) => `${c}=EXCLUDED.${c}`).join(',');
    try {
      await p.query(`INSERT INTO calls (${CALL_COLS.join(',')}) VALUES ${tuples} ON CONFLICT (id) DO UPDATE SET ${upd}`, vals);
      done += chunk.length;
    } catch (e) {
      log.warn('dbUpsertCalls lote falló', { err: String(e) });
    }
  }
  return done;
}

/** ISO de la llamada más reciente sincronizada (marca de agua para el incremental). null si vacía. */
export async function dbCallsWatermarkIso(): Promise<string | null> {
  if (!pool) return null;
  try {
    const r = await pool.query(`SELECT iso FROM calls ORDER BY ts DESC NULLS LAST LIMIT 1`);
    return r.rows[0]?.iso ?? null;
  } catch {
    return null;
  }
}

export async function dbCallsCount(): Promise<number> {
  if (!pool) return 0;
  try {
    const r = await pool.query(`SELECT count(*)::int c FROM calls`);
    return r.rows[0]?.c ?? 0;
  } catch {
    return 0;
  }
}

const ROWS_LIMIT = 1000; // máximo de filas devueltas para la tabla (los KPIs son sobre TODO el rango)

/** KPIs exactos (SQL) + series por hora/día + últimas filas, aplicando filtros. */
export async function dbCallAnalytics(f: CallFilters): Promise<{
  kpis: CallKpis;
  porHora: { h: number; entrantes: number; salientes: number }[];
  porDia: { d: number; entrantes: number; salientes: number }[];
  rowsNorm: NormCall[];
  userIds: number[];
  total: number;
}> {
  const empty = {
    kpis: { total: 0, entrantes: 0, salientes: 0, contestadas: 0, perdidas: 0, durTotal: 0, durProm: 0, tasaContestadas: 0, tasaPerdidas: 0 },
    porHora: Array.from({ length: 24 }, (_, h) => ({ h, entrantes: 0, salientes: 0 })),
    porDia: Array.from({ length: 7 }, (_, d) => ({ d, entrantes: 0, salientes: 0 })),
    rowsNorm: [] as NormCall[],
    userIds: [] as number[],
    total: 0,
  };
  if (!pool) return empty;
  const p = pool;

  const cond: string[] = [];
  const args: any[] = [];
  if (f.from) { args.push(f.from); cond.push(`local_date >= $${args.length}`); }
  if (f.to) { args.push(f.to); cond.push(`local_date <= $${args.length}`); }
  if (f.userId) { args.push(f.userId); cond.push(`user_id = $${args.length}`); }
  if (f.type === 'out') cond.push('is_outbound = true');
  if (f.type === 'in') cond.push('is_outbound = false');
  if (f.status === 'answered') cond.push('contestada = true');
  if (f.status === 'missed') cond.push('contestada = false');
  if (f.phone) { args.push('%' + f.phone + '%'); cond.push(`telefono ILIKE $${args.length}`); }
  const W = cond.length ? 'WHERE ' + cond.join(' AND ') : '';

  try {
    const [kpiR, horaR, diaR, rowsR, userR] = await Promise.all([
      p.query(
        `SELECT count(*)::int total,
          count(*) FILTER (WHERE NOT is_outbound)::int entrantes,
          count(*) FILTER (WHERE is_outbound)::int salientes,
          count(*) FILTER (WHERE contestada)::int contestadas,
          coalesce(sum(duracion) FILTER (WHERE contestada),0)::int durtotal,
          coalesce(round(avg(duracion) FILTER (WHERE contestada)),0)::int durprom
         FROM calls ${W}`,
        args,
      ),
      p.query(
        `SELECT hora, count(*) FILTER (WHERE NOT is_outbound)::int entrantes, count(*) FILTER (WHERE is_outbound)::int salientes
         FROM calls ${W} GROUP BY hora`,
        args,
      ),
      p.query(
        `SELECT dow, count(*) FILTER (WHERE NOT is_outbound)::int entrantes, count(*) FILTER (WHERE is_outbound)::int salientes
         FROM calls ${W} GROUP BY dow`,
        args,
      ),
      p.query(`SELECT * FROM calls ${W} ORDER BY ts DESC NULLS LAST LIMIT ${ROWS_LIMIT}`, args),
      p.query(`SELECT DISTINCT user_id FROM calls WHERE user_id > 0`),
    ]);

    const k = kpiR.rows[0] || {};
    const total = k.total ?? 0;
    const contestadas = k.contestadas ?? 0;
    const perdidas = total - contestadas;
    const kpis: CallKpis = {
      total,
      entrantes: k.entrantes ?? 0,
      salientes: k.salientes ?? 0,
      contestadas,
      perdidas,
      durTotal: k.durtotal ?? 0,
      durProm: k.durprom ?? 0,
      tasaContestadas: total > 0 ? Math.round((contestadas / total) * 100) : 0,
      tasaPerdidas: total > 0 ? Math.round((perdidas / total) * 100) : 0,
    };

    const porHora = Array.from({ length: 24 }, (_, h) => ({ h, entrantes: 0, salientes: 0 }));
    for (const r of horaR.rows) if (r.hora != null && porHora[r.hora]) porHora[r.hora] = { h: r.hora, entrantes: r.entrantes, salientes: r.salientes };
    const porDia = Array.from({ length: 7 }, (_, d) => ({ d, entrantes: 0, salientes: 0 }));
    for (const r of diaR.rows) if (r.dow != null && porDia[r.dow]) porDia[r.dow] = { d: r.dow, entrantes: r.entrantes, salientes: r.salientes };

    const rowsNorm: NormCall[] = rowsR.rows.map((r: any) => ({
      id: r.id, iso: r.iso, localDate: r.local_date, hora: r.hora, dow: r.dow,
      tipoCode: r.tipo_code, isOutbound: r.is_outbound, telefono: r.telefono, duracion: r.duracion,
      usuarioId: r.user_id, estadoCode: r.estado_code, contestada: r.contestada,
      grabacion: r.grabacion, crmTipo: r.crm_tipo || undefined, crmId: r.crm_id || undefined,
    }));
    const userIds = userR.rows.map((r: any) => Number(r.user_id)).filter((n: number) => n > 0);

    return { kpis, porHora, porDia, rowsNorm, userIds, total };
  } catch (e) {
    log.warn('dbCallAnalytics falló', { err: String(e) });
    return empty;
  }
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
    const PROG = `coalesce(nullif(detail->'input'->>'nombre',''), detail->'input'->>'url')`;
    const [
      byType, conv, tools, leadsOk, scoreAgg, intenc, sentim, perDay, embudo, asesores,
      topProg, topInteres, porTipo, porFacultad, gaps, capturaConvs, escalConvs, scoreBuckets, porHora,
    ] = await Promise.all([
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
      q(`SELECT detail->>'responsableId' id, count(*)::int c, count(DISTINCT dialog_id)::int convs, round(avg((detail->>'score')::numeric))::int avg
         FROM audit_log WHERE type='lead_score' AND detail->>'responsableId' IS NOT NULL AND detail->>'responsableId' NOT IN ('-1','0') ${W} GROUP BY 1 ORDER BY 3 DESC LIMIT 25`),
      // Demanda de programas
      q(`SELECT ${PROG} k, count(*)::int c FROM audit_log WHERE type='tool_call' AND detail->>'name'='detalle_programa' AND ${PROG} IS NOT NULL ${W} GROUP BY 1 ORDER BY 2 DESC LIMIT 10`),
      q(`SELECT detail->'input'->>'programa_interes' k, count(*)::int c FROM audit_log WHERE type='tool_call' AND detail->>'name'='registrar_interes_crm' AND detail->'input'->>'programa_interes' IS NOT NULL ${W} GROUP BY 1 ORDER BY 2 DESC LIMIT 10`),
      q(`SELECT detail->'input'->>'tipo' k, count(*)::int c FROM audit_log WHERE type='tool_call' AND detail->>'name'='consultar_programas' AND detail->'input'->>'tipo' IS NOT NULL ${W} GROUP BY 1 ORDER BY 2 DESC`),
      q(`SELECT detail->'input'->>'facultad' k, count(*)::int c FROM audit_log WHERE type='tool_call' AND detail->>'name'='consultar_programas' AND detail->'input'->>'facultad' IS NOT NULL ${W} GROUP BY 1 ORDER BY 2 DESC LIMIT 10`),
      q(`SELECT ${PROG} k, count(*)::int c FROM audit_log WHERE type='tool_call' AND detail->>'name'='detalle_programa' AND detail->>'ok'='false' AND ${PROG} IS NOT NULL ${W} GROUP BY 1 ORDER BY 2 DESC LIMIT 10`),
      // Conversión del bot
      q(`SELECT count(DISTINCT dialog_id)::int c FROM audit_log WHERE type='tool_call' AND detail->>'name'='registrar_interes_crm' AND detail->>'ok'='true' ${W}`),
      q(`SELECT count(DISTINCT dialog_id)::int c FROM audit_log WHERE ((type='tool_call' AND detail->>'name'='escalar_a_humano') OR type='auto_escalation') ${W}`),
      q(`SELECT (CASE WHEN s>=70 THEN 'alto' WHEN s>=40 THEN 'medio' ELSE 'bajo' END) b, count(*)::int c
         FROM (SELECT dialog_id, max((detail->>'score')::int) s FROM audit_log WHERE type='lead_score' AND detail->>'score' IS NOT NULL ${W} GROUP BY dialog_id) t GROUP BY 1`),
      // Horarios
      q(`SELECT extract(hour from ts)::int h, count(*)::int c FROM audit_log WHERE type='turn' ${W} GROUP BY 1 ORDER BY 1`),
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
      porAsesor: asesores.rows, // [{id, c, convs, avg}]
      // Demanda de programas
      topProgramas: topProg.rows, // [{k, c}]
      topInteres: topInteres.rows,
      porTipo: map(porTipo.rows, 'k'),
      porFacultad: porFacultad.rows,
      gapsCatalogo: gaps.rows,
      // Conversión del bot
      capturaConvs: capturaConvs.rows[0]?.c ?? 0,
      escalConvs: escalConvs.rows[0]?.c ?? 0,
      scoreBuckets: map(scoreBuckets.rows, 'b'),
      // Horarios / operación
      porHora: porHora.rows, // [{h, c}]
      operadorMsgs: byTypeMap['operator_msg'] ?? 0,
      byType: byTypeMap,
    };
  } catch (e) {
    log.warn('dbMetricsSummary falló', { err: String(e) });
    return null;
  }
}
