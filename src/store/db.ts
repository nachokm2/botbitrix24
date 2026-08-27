import pg from 'pg';
import { config } from '../config';
import { log } from '../log';
import { once } from './kv';
import { inc } from '../obs/metrics';
import type { NormCall, CallFilters, CallKpis } from '../crm/callStats';
import type { CampaignTarget, CallAttempt } from '../campaign/types';

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
      max: Number(process.env.PGPOOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    // Un cliente idle cerrado por el servidor (reinicio/failover de PG) NO debe tumbar el proceso.
    pool.on('error', (err) => log.warn('pg pool: error en cliente idle', { err: String(err) }));
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
    // Índice para las agregaciones por `type` de /metrics/summary (evita seq-scan al crecer la tabla).
    await pool.query(`CREATE INDEX IF NOT EXISTS audit_log_type_ts_idx ON audit_log (type, ts DESC);`);
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
    // ── Campaña de voz saliente (Fase 0): estado por Deal + auditoría fina de intentos ──
    await pool.query(`
      CREATE TABLE IF NOT EXISTS campaign_target (
        deal_id        BIGINT PRIMARY KEY,
        program_code   TEXT NOT NULL,
        contact_id     BIGINT,
        phone_e164     TEXT,
        status         TEXT NOT NULL DEFAULT 'PENDING',
        day_index      SMALLINT NOT NULL DEFAULT 1,
        attempts_total SMALLINT NOT NULL DEFAULT 0,
        attempts_today SMALLINT NOT NULL DEFAULT 0,
        today_date     DATE,
        last_wave      TEXT,
        last_attempt_at   TIMESTAMPTZ,
        next_attempt_at   TIMESTAMPTZ,
        answered_at    TIMESTAMPTZ,
        last_outcome   TEXT,
        classification TEXT,
        lead_score     SMALLINT,
        priority       TEXT,
        asesor_id      BIGINT,
        opted_out      BOOLEAN NOT NULL DEFAULT false,
        whatsapp_sent  BOOLEAN NOT NULL DEFAULT false,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS ct_due_idx ON campaign_target (program_code, status, next_attempt_at);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS ct_status_idx ON campaign_target (status);`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS call_attempt (
        id             BIGSERIAL PRIMARY KEY,
        deal_id        BIGINT NOT NULL,
        program_code   TEXT NOT NULL,
        attempt_no     SMALLINT NOT NULL,
        wave_slot      TEXT,
        scheduled_at   TIMESTAMPTZ,
        vapi_call_id   TEXT,
        started_at     TIMESTAMPTZ,
        ended_at       TIMESTAMPTZ,
        ended_reason   TEXT,
        duration_sec   INT,
        answered       BOOLEAN,
        outcome_code   TEXT,
        classification TEXT,
        lead_score     SMALLINT,
        factores       JSONB,
        objeciones     JSONB,
        temas          JSONB,
        resumen        TEXT,
        recording_url  TEXT,
        transcript_ref TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS ca_deal_idx ON call_attempt (deal_id, attempt_no);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS ca_vapi_idx ON call_attempt (vapi_call_id);`);
    log.info('DB: Postgres conectado y tablas audit_log/calls/campaign_target/call_attempt listas');
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
    inc('errors:audit'); // BAJ-13: visibilizar pérdida de auditoría
    log.warn('dbInsertAudit falló', { err: String(err) });
  }
}

export async function dbRecentAudit(limit = 20): Promise<any[]> {
  if (!pool) return [];
  try {
    const r = await pool.query(
      // No devolver `detail` (contiene el texto de la conversación / PII); el panel solo usa type/dialog_id/crm_entity.
      `SELECT ts, type, dialog_id, crm_entity FROM audit_log ORDER BY ts DESC LIMIT $1`,
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

/** Borra auditoría más antigua que `days` días. Devuelve cuántas filas se borraron. */
export async function dbPurgeOldAudit(days: number): Promise<number> {
  if (!pool || days <= 0) return 0;
  try {
    const r = await pool.query(`DELETE FROM audit_log WHERE ts < now() - ($1 || ' days')::interval`, [String(days)]);
    return r.rowCount ?? 0;
  } catch (e) {
    log.warn('dbPurgeOldAudit falló', { err: String(e) });
    return 0;
  }
}

/**
 * Arranca el barrido de retención de auditoría (si AUDIT_RETENTION_DAYS>0 y hay Postgres).
 * Corre ~1 vez al día, con lock distribuido (once) para que solo una réplica purgue.
 */
export function startRetentionSweep(): void {
  const days = config.auditRetentionDays;
  if (!pool || days <= 0) {
    log.info('retención de auditoría: desactivada (define AUDIT_RETENTION_DAYS>0).');
    return;
  }
  const run = async () => {
    if (!(await once('lock:audit-purge', 23 * 3600))) return; // ~1 vez/día entre réplicas
    const deleted = await dbPurgeOldAudit(days);
    if (deleted) log.info('retención de auditoría: filas borradas', { deleted, days });
  };
  setTimeout(run, 60_000); // primera pasada al minuto del arranque
  setInterval(run, 24 * 3600 * 1000);
  log.info('retención de auditoría: activa', { retencionDias: days });
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

/** ¿Hay al menos una llamada sincronizada? Más barato que count(*) para decidir db vs live. */
export async function dbHasCalls(): Promise<boolean> {
  if (!pool) return false;
  try {
    const r = await pool.query(`SELECT 1 FROM calls LIMIT 1`);
    return r.rows.length > 0;
  } catch {
    return false;
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
      respWhatsapp, convDurWhatsapp, callDur,
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
      // Tiempos: respuesta del bot por WhatsApp (ms, instrumentado por turno)
      q(`SELECT round(avg((detail->>'responseMs')::numeric))::int avg, count(*)::int c
         FROM audit_log WHERE type='turn' AND detail->>'responseMs' IS NOT NULL ${W}`),
      // Tiempos: duración de conversación por WhatsApp (seg, primer→último turno por diálogo)
      q(`SELECT round(avg(extract(epoch from (last_ts - first_ts))))::int avg, count(*)::int c
         FROM (SELECT dialog_id, min(ts) first_ts, max(ts) last_ts FROM audit_log
               WHERE type='turn' AND dialog_id IS NOT NULL ${W} GROUP BY dialog_id) t`),
      // Tiempos: duración de llamadas (seg, del end-of-call-report de Vapi)
      q(`SELECT round(avg((detail->>'duration')::numeric))::int avg, count(*)::int c
         FROM audit_log WHERE type='voice_call' AND detail->>'duration' IS NOT NULL ${W}`),
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
      // Tiempos de respuesta/conversación
      respuestaWhatsappMs: respWhatsapp.rows[0]?.avg ?? null,
      duracionConvWhatsappSeg: convDurWhatsapp.rows[0]?.avg ?? null,
      duracionLlamadaSeg: callDur.rows[0]?.avg ?? null,
    };
  } catch (e) {
    log.warn('dbMetricsSummary falló', { err: String(e) });
    return null;
  }
}

// ─────────────────────────── Scorecard "marcha blanca" (métricas nativas del bot, por programa) ───────────────────────────

export type MarchaBlancaBotStats = {
  key: string;
  mensajes: number;
  escalamientos: number;
  llamadasIA: number;
  slaContactoSeg: number | null;
  slaContactoN: number;
  /** IDs de Deal escalados a un asesor (best-effort: solo cuando la entidad del CRM ya era un Deal en
   *  el momento de escalar) — para cruzar después con los que llegaron a matrícula (WON) en Bitrix. */
  escaladosDealIds: number[];
};

/** Métricas que vienen 100% de audit_log (Postgres), filtradas por programa (match/exclude en texto
 *  libre capturado por el bot). El SLA de contacto es tiempo entre escalar_a_humano/auto_escalation y
 *  el primer mensaje de un OPERADOR humano en ese mismo diálogo (operator_msg ya se registra cuando
 *  alguien != el cliente escribe en el chat de WhatsApp — ver routes/botEvents.ts). */
export async function dbMarchaBlancaBot(range = 'all'): Promise<MarchaBlancaBotStats[]> {
  if (!pool) return [];
  const p = pool;
  const interval = range in RANGE_INTERVAL ? RANGE_INTERVAL[range] : null;
  const W = interval ? `AND ts >= now() - interval '${interval}'` : ''; // interval viene de whitelist

  const out: MarchaBlancaBotStats[] = [];
  for (const prog of config.marchaBlancaProgramas) {
    const matchPat = `%${prog.match}%`;
    const excludePat = prog.exclude ? `%${prog.exclude}%` : null;
    const progDialogsSql = `
      SELECT DISTINCT dialog_id FROM audit_log
      WHERE type='tool_call' AND detail->>'name'='registrar_interes_crm'
        AND detail->'input'->>'programa_interes' ILIKE $1
        AND ($2::text IS NULL OR detail->'input'->>'programa_interes' NOT ILIKE $2)
        AND dialog_id IS NOT NULL`;
    try {
      const [msgR, escR, callR, slaR, escEntR] = await Promise.all([
        p.query(`SELECT count(*)::int c FROM audit_log WHERE type='turn' ${W} AND dialog_id IN (${progDialogsSql})`, [matchPat, excludePat]),
        p.query(
          `SELECT count(*)::int c FROM audit_log
           WHERE ((type='auto_escalation') OR (type='tool_call' AND detail->>'name'='escalar_a_humano')) ${W}
             AND dialog_id IN (${progDialogsSql})`,
          [matchPat, excludePat],
        ),
        p.query(
          `SELECT count(*)::int c FROM audit_log
           WHERE type='voice_call' ${W}
             AND detail->>'programaInteres' ILIKE $1
             AND ($2::text IS NULL OR detail->>'programaInteres' NOT ILIKE $2)`,
          [matchPat, excludePat],
        ),
        p.query(
          `WITH esc AS (
             SELECT dialog_id, min(ts) esc_ts FROM audit_log
             WHERE ((type='auto_escalation') OR (type='tool_call' AND detail->>'name'='escalar_a_humano')) ${W}
               AND dialog_id IN (${progDialogsSql})
             GROUP BY dialog_id
           ),
           contact AS (
             SELECT e.dialog_id, min(o.ts) contact_ts
             FROM esc e JOIN audit_log o ON o.dialog_id = e.dialog_id AND o.type='operator_msg' AND o.ts > e.esc_ts
             GROUP BY e.dialog_id
           )
           SELECT round(avg(extract(epoch from (contact_ts - esc_ts))))::int avg, count(*)::int c
           FROM esc JOIN contact USING (dialog_id)`,
          [matchPat, excludePat],
        ),
        p.query(
          `SELECT DISTINCT crm_entity FROM audit_log
           WHERE ((type='auto_escalation') OR (type='tool_call' AND detail->>'name'='escalar_a_humano')) ${W}
             AND crm_entity LIKE 'deal#%'
             AND dialog_id IN (${progDialogsSql})`,
          [matchPat, excludePat],
        ),
      ]);
      out.push({
        key: prog.key,
        mensajes: msgR.rows[0]?.c ?? 0,
        escalamientos: escR.rows[0]?.c ?? 0,
        llamadasIA: callR.rows[0]?.c ?? 0,
        slaContactoSeg: slaR.rows[0]?.avg ?? null,
        slaContactoN: slaR.rows[0]?.c ?? 0,
        escaladosDealIds: escEntR.rows.map((r: any) => Number(String(r.crm_entity).split('#')[1])).filter((n: number) => n > 0),
      });
    } catch (e) {
      log.warn('dbMarchaBlancaBot falló', { err: String(e), programa: prog.key });
      out.push({ key: prog.key, mensajes: 0, escalamientos: 0, llamadasIA: 0, slaContactoSeg: null, slaContactoN: 0, escaladosDealIds: [] });
    }
  }
  return out;
}

// ─────────────────────────── Campaña de voz saliente (plano de control) ───────────────────────────
// Todas estas funciones son no-op cuando no hay Postgres (pool === null): la campaña se degrada a
// "sin memoria de reintentos" sin tumbar el resto del bot. Las escrituras usan un whitelist de columnas
// para el UPDATE parcial (evita inyección) y mapean camelCase ↔ snake_case.

const CT_COLS: Record<string, string> = {
  contactId: 'contact_id', phoneE164: 'phone_e164', status: 'status', dayIndex: 'day_index',
  attemptsTotal: 'attempts_total', attemptsToday: 'attempts_today', todayDate: 'today_date',
  lastWave: 'last_wave', lastAttemptAt: 'last_attempt_at', nextAttemptAt: 'next_attempt_at',
  answeredAt: 'answered_at', lastOutcome: 'last_outcome', classification: 'classification',
  leadScore: 'lead_score', priority: 'priority', asesorId: 'asesor_id', optedOut: 'opted_out',
  whatsappSent: 'whatsapp_sent',
};

const CA_COLS: Record<string, string> = {
  startedAt: 'started_at', endedAt: 'ended_at', endedReason: 'ended_reason', durationSec: 'duration_sec',
  answered: 'answered', outcomeCode: 'outcome_code', classification: 'classification', leadScore: 'lead_score',
  factores: 'factores', objeciones: 'objeciones', temas: 'temas', resumen: 'resumen',
  recordingUrl: 'recording_url', transcriptRef: 'transcript_ref',
};
const CA_JSON = new Set(['factores', 'objeciones', 'temas']);

function rowToTarget(r: any): CampaignTarget {
  return {
    dealId: Number(r.deal_id), programCode: r.program_code, contactId: r.contact_id, phoneE164: r.phone_e164,
    status: r.status, dayIndex: r.day_index, attemptsTotal: r.attempts_total, attemptsToday: r.attempts_today,
    todayDate: r.today_date, lastWave: r.last_wave, lastAttemptAt: r.last_attempt_at, nextAttemptAt: r.next_attempt_at,
    answeredAt: r.answered_at, lastOutcome: r.last_outcome, classification: r.classification, leadScore: r.lead_score,
    priority: r.priority, asesorId: r.asesor_id, optedOut: r.opted_out, whatsappSent: r.whatsapp_sent,
  };
}

/** Alta (o refresco de datos) de un Deal en la campaña. En conflicto NO pisa el estado en curso: solo
 *  actualiza teléfono/contacto/programa. Devuelve true si tocó Postgres. */
export async function dbEnrollCampaignTarget(
  t: { dealId: number; programCode: string; contactId?: number | null; phoneE164?: string | null },
): Promise<boolean> {
  if (!pool) return false;
  try {
    await pool.query(
      `INSERT INTO campaign_target (deal_id, program_code, contact_id, phone_e164, status)
       VALUES ($1,$2,$3,$4,'PENDING')
       ON CONFLICT (deal_id) DO UPDATE SET
         program_code = EXCLUDED.program_code,
         contact_id   = COALESCE(EXCLUDED.contact_id, campaign_target.contact_id),
         phone_e164   = COALESCE(EXCLUDED.phone_e164, campaign_target.phone_e164),
         updated_at   = now()`,
      [t.dealId, t.programCode, t.contactId ?? null, t.phoneE164 ?? null],
    );
    return true;
  } catch (e) {
    log.warn('dbEnrollCampaignTarget falló', { err: String(e) });
    return false;
  }
}

export async function dbGetCampaignTarget(dealId: number): Promise<CampaignTarget | null> {
  if (!pool) return null;
  try {
    const r = await pool.query(`SELECT * FROM campaign_target WHERE deal_id = $1`, [dealId]);
    return r.rows[0] ? rowToTarget(r.rows[0]) : null;
  } catch (e) {
    log.warn('dbGetCampaignTarget falló', { err: String(e) });
    return null;
  }
}

/**
 * Cola del scheduler: targets elegibles de un programa cuya próxima llamada ya vence. Excluye los que
 * ya contestaron, opt-out, con WhatsApp enviado, o que agotaron intentos/días. `nowIso` y los topes
 * (maxTotal/maxDias) los aporta el llamador desde ProgramConfig.
 */
export async function dbDueCampaignTargets(
  programCode: string,
  nowIso: string,
  opts: { maxTotal: number; maxDias: number; limit: number },
): Promise<CampaignTarget[]> {
  if (!pool) return [];
  try {
    const r = await pool.query(
      `SELECT * FROM campaign_target
       WHERE program_code = $1
         AND status IN ('PENDING','SIN_RESPUESTA','CALLBACK','NO_TITULAR')
         AND opted_out = false
         AND answered_at IS NULL
         AND whatsapp_sent = false
         AND attempts_total < $2
         AND day_index <= $3
         AND (next_attempt_at IS NULL OR next_attempt_at <= $4::timestamptz)
       ORDER BY next_attempt_at ASC NULLS FIRST, updated_at ASC
       LIMIT $5`,
      [programCode, opts.maxTotal, opts.maxDias, nowIso, opts.limit],
    );
    return r.rows.map(rowToTarget);
  } catch (e) {
    log.warn('dbDueCampaignTargets falló', { err: String(e) });
    return [];
  }
}

/** UPDATE parcial del estado de un target (whitelist de columnas). */
export async function dbUpdateCampaignTarget(dealId: number, patch: Partial<CampaignTarget>): Promise<void> {
  if (!pool) return;
  const sets: string[] = [];
  const vals: any[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = CT_COLS[k];
    if (!col) continue;
    vals.push(v === undefined ? null : v);
    sets.push(`${col} = $${vals.length}`);
  }
  if (!sets.length) return;
  vals.push(dealId);
  try {
    await pool.query(`UPDATE campaign_target SET ${sets.join(', ')}, updated_at = now() WHERE deal_id = $${vals.length}`, vals);
  } catch (e) {
    log.warn('dbUpdateCampaignTarget falló', { err: String(e) });
  }
}

/** Inserta el registro de un intento (al disparar la llamada). Devuelve el id, o null. */
export async function dbInsertCallAttempt(
  a: { dealId: number; programCode: string; attemptNo: number; waveSlot?: string | null; scheduledAt?: string | null; vapiCallId?: string | null },
): Promise<number | null> {
  if (!pool) return null;
  try {
    const r = await pool.query(
      `INSERT INTO call_attempt (deal_id, program_code, attempt_no, wave_slot, scheduled_at, vapi_call_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [a.dealId, a.programCode, a.attemptNo, a.waveSlot ?? null, a.scheduledAt ?? null, a.vapiCallId ?? null],
    );
    return r.rows[0]?.id ?? null;
  } catch (e) {
    log.warn('dbInsertCallAttempt falló', { err: String(e) });
    return null;
  }
}

/** UPDATE parcial de un intento por su vapi_call_id (al terminar/clasificar la llamada). */
export async function dbUpdateCallAttemptByVapiId(vapiCallId: string, patch: Partial<CallAttempt>): Promise<void> {
  if (!pool) return;
  const sets: string[] = [];
  const vals: any[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = CA_COLS[k];
    if (!col) continue;
    vals.push(v === undefined ? null : CA_JSON.has(k) ? JSON.stringify(v) : v);
    sets.push(`${col} = $${vals.length}`);
  }
  if (!sets.length) return;
  vals.push(vapiCallId);
  try {
    await pool.query(`UPDATE call_attempt SET ${sets.join(', ')} WHERE vapi_call_id = $${vals.length}`, vals);
  } catch (e) {
    log.warn('dbUpdateCallAttemptByVapiId falló', { err: String(e) });
  }
}

/** Conteo de targets por estado (para el dashboard operativo). */
export async function dbCampaignCounts(programCode: string): Promise<Record<string, number>> {
  if (!pool) return {};
  try {
    const r = await pool.query(
      `SELECT status, count(*)::int c FROM campaign_target WHERE program_code = $1 GROUP BY status`,
      [programCode],
    );
    return Object.fromEntries(r.rows.map((x: any) => [x.status, x.c]));
  } catch (e) {
    log.warn('dbCampaignCounts falló', { err: String(e) });
    return {};
  }
}

/** Agregaciones para el dashboard operativo de la campaña (KPIs + distribuciones + últimos intentos). */
export async function dbCampaignDashboard(programCode: string): Promise<Record<string, any> | null> {
  if (!pool) return null;
  const p = pool;
  const mapC = (rows: any[], k = 'k') => Object.fromEntries(rows.filter((r) => r[k] != null).map((r) => [r[k], r.c]));
  try {
    const [byStatus, targetAgg, clasif, porAsesor, attemptsAgg, byOutcome, recientes] = await Promise.all([
      p.query(`SELECT status, count(*)::int c FROM campaign_target WHERE program_code=$1 GROUP BY status`, [programCode]),
      p.query(
        `SELECT count(*)::int total,
                count(*) FILTER (WHERE opted_out)::int optedout,
                count(*) FILTER (WHERE whatsapp_sent)::int wasent,
                round(avg(lead_score) FILTER (WHERE answered_at IS NOT NULL))::int scoreprom
         FROM campaign_target WHERE program_code=$1`,
        [programCode],
      ),
      p.query(`SELECT classification k, count(*)::int c FROM campaign_target WHERE program_code=$1 AND classification IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`, [programCode]),
      p.query(`SELECT asesor_id id, count(*)::int c FROM campaign_target WHERE program_code=$1 AND status='ESCALADO' AND asesor_id IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`, [programCode]),
      p.query(
        `SELECT count(*)::int total,
                count(*) FILTER (WHERE answered)::int answered,
                count(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int hoy
         FROM call_attempt WHERE program_code=$1`,
        [programCode],
      ),
      p.query(`SELECT outcome_code k, count(*)::int c FROM call_attempt WHERE program_code=$1 AND outcome_code IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`, [programCode]),
      p.query(
        `SELECT deal_id, attempt_no, outcome_code, classification, lead_score,
                to_char(coalesce(ended_at, created_at), 'YYYY-MM-DD HH24:MI') ts
         FROM call_attempt WHERE program_code=$1 ORDER BY coalesce(ended_at, created_at) DESC NULLS LAST LIMIT 25`,
        [programCode],
      ),
    ]);
    const st = mapC(byStatus.rows, 'status');
    const ta = targetAgg.rows[0] || {};
    const aa = attemptsAgg.rows[0] || {};
    const answered = aa.answered ?? 0;
    const total = aa.total ?? 0;
    const escalados = st['ESCALADO'] ?? 0;
    return {
      targets: { total: ta.total ?? 0, byStatus: st, optedOut: ta.optedout ?? 0, whatsappSent: ta.wasent ?? 0, scoreProm: ta.scoreprom ?? null },
      attempts: { total, answered, hoy: aa.hoy ?? 0, byOutcome: mapC(byOutcome.rows) },
      clasificaciones: mapC(clasif.rows),
      porAsesor: porAsesor.rows, // [{id, c}]
      kpis: {
        tasaContacto: total > 0 ? Math.round((answered / total) * 100) : 0,
        tasaEscalamiento: answered > 0 ? Math.round((escalados / answered) * 100) : 0,
        escalados,
        noInteresados: st['NO_INTERESADO'] ?? 0,
        agotados: st['AGOTADO'] ?? 0,
        recuperacion: st['RECUPERACION'] ?? 0,
      },
      recientes: recientes.rows,
    };
  } catch (e) {
    log.warn('dbCampaignDashboard falló', { err: String(e) });
    return null;
  }
}
