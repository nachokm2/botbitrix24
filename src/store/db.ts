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

async function intentarConexion(): Promise<boolean> {
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
    notificarReady();
    return true;
  } catch (e) {
    log.error('DB: init falló, auditoría solo en logs (se reintentará)', { err: String(e) });
    if (pool) await pool.end().catch(() => {}); // no fugar el pool a medio abrir entre reintentos
    pool = null;
    return false;
  }
}

// Reconexión en segundo plano (INF-05): si Postgres no está disponible al arrancar (p. ej. Railway
// reinició la BD), antes el pool quedaba en null para siempre y había que reiniciar el bot a mano —
// el panel mostraba "Requiere Postgres" sin un solo error en los logs. Ahora se reintenta cada 30 s
// hasta conectar; al quedar listo se dispara onReady UNA vez, para armar las tareas que necesitan el
// pool ya al arrancar (sync de llamadas y retención, que hacen return si !pool). El resto de
// schedulers comprueban el pool en cada tick, así que se recuperan solos sin necesidad de onReady.
let reconexionTimer: ReturnType<typeof setInterval> | null = null;
let onReadyCb: (() => void) | null = null;
let readyNotificado = false;
const MS_REINTENTO_DB = 30_000;

function notificarReady(): void {
  if (readyNotificado) return;
  readyNotificado = true;
  try {
    onReadyCb?.();
  } catch (e) {
    log.error('initDb onReady falló', { err: String(e) });
  }
}

function programarReintento(): void {
  if (reconexionTimer) return;
  reconexionTimer = setInterval(() => {
    void intentarConexion().then((ok) => {
      if (ok && reconexionTimer) {
        clearInterval(reconexionTimer);
        reconexionTimer = null;
      }
    });
  }, MS_REINTENTO_DB);
  reconexionTimer.unref?.(); // no mantener vivo el proceso solo por este timer
}

/**
 * Conecta a Postgres y crea las tablas. Sin DATABASE_URL queda en modo "solo logs". Si la conexión
 * inicial falla, NO se rinde: reintenta en segundo plano hasta lograrlo (INF-05). `onReady` se invoca
 * una sola vez, cuando el pool queda listo (en el arranque o tras una reconexión posterior).
 */
export async function initDb(onReady?: () => void): Promise<void> {
  onReadyCb = onReady ?? null;
  if (!config.databaseUrl) {
    log.info('DB: sin DATABASE_URL → auditoría solo en logs');
    return;
  }
  const ok = await intentarConexion();
  if (!ok) programarReintento();
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

/** Fallas técnicas recientes, con el motivo y en qué etapa del turno ocurrieron. A diferencia del
 *  resto de la auditoría, acá SÍ se devuelve parte del detalle (etapa + mensaje de error): no lleva
 *  el texto de la conversación, y sin él un error en el panel es un número que nadie puede accionar.
 *  Existe porque un fallo al ENVIAR la respuesta dejaba al cliente sin contestación y no quedaba
 *  rastro en ninguna parte (3 clientes reales así, ver fix 748885f). */
export async function dbErroresRecientes(limit = 15): Promise<any[]> {
  if (!pool) return [];
  try {
    const r = await pool.query(
      `SELECT ts, dialog_id, crm_entity,
              detail->>'etapa' etapa,
              left(coalesce(detail->>'err',''), 200) err
       FROM audit_log WHERE type='error' ORDER BY ts DESC LIMIT $1`,
      [limit],
    );
    return r.rows;
  } catch (err) {
    log.warn('dbErroresRecientes falló', { err: String(err) });
    return [];
  }
}

/**
 * Conversaciones recientes, para poder LEERLAS desde el panel. Antes no había forma: "Actividad
 * reciente" muestra solo metadatos (tipo, diálogo, entidad) porque `detail` trae el texto y se
 * excluyó a propósito. Pero sin leer lo que el bot respondió no se puede evaluar si lo hizo bien —
 * y los dos problemas que encontramos en producción salieron justamente de leer conversaciones.
 *
 * Va detrás del token del panel, igual que el resto, y muestra lo mismo que esas personas ya ven en
 * el chat de Bitrix24: no abre acceso nuevo, solo evita tener que buscarlo conversación por
 * conversación.
 */
export async function dbConversaciones(limit = 30, range = 'all'): Promise<{ total: number; filas: any[] }> {
  if (!pool) return { total: 0, filas: [] };
  // Respeta el selector de rango del panel: antes devolvía siempre las últimas de SIEMPRE, así que
  // con "Hoy" seleccionado podía listar conversaciones de otro día. Y devuelve el TOTAL del rango,
  // no solo las que caben: la sección decía "30 conversaciones" mientras la tarjeta de arriba decía
  // 66, como si fueran datos distintos — eran las mismas, truncadas sin avisar.
  const interval = range in RANGE_INTERVAL ? RANGE_INTERVAL[range] : null;
  const W = interval ? `AND ts >= now() - interval '${interval}'` : '';
  try {
    const t = await pool.query(
      `SELECT count(DISTINCT dialog_id)::int c FROM audit_log WHERE type='turn' AND dialog_id IS NOT NULL ${W}`,
    );
    const r = await pool.query(
      `SELECT dialog_id,
              max(crm_entity) FILTER (WHERE crm_entity IS NOT NULL) AS crm_entity,
              count(*)::int AS turnos,
              min(ts) AS inicio,
              max(ts) AS fin,
              (array_agg(detail->>'message' ORDER BY ts DESC))[1] AS ultimo_mensaje
       FROM audit_log
       WHERE type='turn' AND dialog_id IS NOT NULL ${W}
       GROUP BY dialog_id
       ORDER BY max(ts) DESC
       LIMIT $1`,
      [limit],
    );
    return { total: t.rows[0]?.c ?? 0, filas: r.rows };
  } catch (err) {
    log.warn('dbConversaciones falló', { err: String(err) });
    return { total: 0, filas: [] };
  }
}

/** El intercambio completo de UNA conversación: cada turno con lo que dijo el cliente y lo que
 *  respondió el bot, en orden cronológico. */
export async function dbConversacion(dialogId: string, limit = 100): Promise<any[]> {
  if (!pool || !dialogId) return [];
  try {
    const r = await pool.query(
      `SELECT ts, crm_entity, detail->>'message' AS mensaje, detail->>'reply' AS respuesta
       FROM audit_log
       WHERE type='turn' AND dialog_id = $1
       ORDER BY ts ASC
       LIMIT $2`,
      [dialogId, limit],
    );
    return r.rows;
  } catch (err) {
    log.warn('dbConversacion falló', { err: String(err), dialogId });
    return [];
  }
}

/** ¿Escribió un empleado en ese chat después de cierto momento? Es la señal más directa de que una
 *  persona tomó el caso: un asesor puede responder por WhatsApp sin tocar nunca la negociación.
 *  La usa la vigilancia de derivaciones (crm/vigilanciaDerivaciones.ts). */
export async function dbHuboOperadorDespuesDe(dialogId: string, desde: Date): Promise<boolean> {
  if (!pool || !dialogId) return false;
  try {
    const r = await pool.query(
      `SELECT 1 FROM audit_log WHERE type='operator_msg' AND dialog_id = $1 AND ts > $2 LIMIT 1`,
      [dialogId, desde.toISOString()],
    );
    return r.rowCount! > 0;
  } catch (err) {
    log.warn('dbHuboOperadorDespuesDe falló', { err: String(err), dialogId });
    return false;
  }
}

// Zona horaria con la que se AGRUPA el tiempo en el panel. Postgres corre en UTC, así que sin esto
// una conversación de las 14:24 en Chile aparecía en la barra de las 17 del gráfico de horarios, y
// lo ocurrido después de las 21 se contaba como del día siguiente. Misma zona que usa el seguimiento
// automático (ai/seguimiento.ts) para decidir a qué hora puede escribirle a alguien.
// Se valida porque se interpola en SQL: una zona IANA son letras, barras y guiones, nada más. Un
// valor con comillas podría salirse de la cadena, aunque la variable la controle quien despliega.
const TZ_PANEL = /^[A-Za-z0-9_\/+-]{1,64}$/.test(process.env.PANEL_TIMEZONE ?? '')
  ? (process.env.PANEL_TIMEZONE as string)
  : 'America/Santiago';

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

/**
 * Estado de Postgres para /health (INF-07). 'off' = no configurado (sin DATABASE_URL); 'down' =
 * configurado pero sin conexión usable (BD caída o aún reconectando); 'up' = responde una consulta
 * trivial. No lanza y tiene un tope de 2 s para que /health nunca quede pegado si PG no responde.
 */
export async function dbHealth(): Promise<'up' | 'down' | 'off'> {
  if (!config.databaseUrl) return 'off';
  const p = pool;
  if (!p) return 'down';
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      p.query('SELECT 1'),
      new Promise((_, rej) => {
        t = setTimeout(() => rej(new Error('timeout')), 2000);
      }),
    ]);
    return 'up';
  } catch {
    return 'down';
  } finally {
    if (t) clearTimeout(t);
  }
}

/** Tablas de histórico con datos personales que la retención purga por antigüedad, y su columna de
 *  tiempo. NO incluye campaign_target A PROPÓSITO: no es histórico sino estado operativo de la campaña
 *  (status, opted_out, next_attempt_at…), y borrar una fila ahí re-habilitaría llamadas a quien se dio
 *  de baja o re-enrolaría un deal. Su minimización, si hace falta, es anonimizar el teléfono, no borrar
 *  la fila — queda como decisión aparte. */
const TABLAS_RETENCION: ReadonlyArray<{ tabla: string; col: string }> = [
  { tabla: 'audit_log', col: 'ts' }, // transcripciones y detalle de cada turno
  { tabla: 'calls', col: 'ts' }, // espejo de telefonía: teléfono, grabación
  { tabla: 'call_attempt', col: 'created_at' }, // intentos de campaña: grabación, transcripción, resumen
];

/** Borra datos más antiguos que `days` días de las tablas de histórico. Devuelve cuántas filas se
 *  borraron por tabla. Cada tabla se purga por separado: un fallo en una no impide purgar las demás. */
export async function dbPurgeOldData(days: number): Promise<Record<string, number>> {
  const borradas: Record<string, number> = {};
  if (!pool || days <= 0) return borradas;
  for (const { tabla, col } of TABLAS_RETENCION) {
    try {
      // tabla/col son literales fijos de TABLAS_RETENCION (no entrada externa); days va parametrizado.
      const r = await pool.query(`DELETE FROM ${tabla} WHERE ${col} < now() - ($1 || ' days')::interval`, [String(days)]);
      if (r.rowCount) borradas[tabla] = r.rowCount;
    } catch (e) {
      log.warn('dbPurgeOldData falló en una tabla', { tabla, err: String(e) });
    }
  }
  return borradas;
}

/**
 * Arranca el barrido de retención (si AUDIT_RETENTION_DAYS>0 y hay Postgres). Purga las tablas de
 * histórico con datos personales (audit_log, calls, call_attempt). Corre ~1 vez al día, con lock
 * distribuido (once) para que solo una réplica purgue.
 */
export function startRetentionSweep(): void {
  const days = config.auditRetentionDays;
  if (!pool || days <= 0) {
    log.info('retención: desactivada (define AUDIT_RETENTION_DAYS>0).');
    return;
  }
  const run = async () => {
    if (!(await once('lock:audit-purge', 23 * 3600))) return; // ~1 vez/día entre réplicas
    const borradas = await dbPurgeOldData(days);
    const total = Object.values(borradas).reduce((a, b) => a + b, 0);
    if (total) log.info('retención: filas borradas', { porTabla: borradas, total, days });
  };
  setTimeout(run, 60_000); // primera pasada al minuto del arranque
  setInterval(run, 24 * 3600 * 1000);
  log.info('retención: activa', { retencionDias: days, tablas: TABLAS_RETENCION.map((t) => t.tabla) });
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
  // Embudos propios de la marca. Se interpola en SQL, así que se fuerza a enteros: config ya los
  // valida, y este segundo filtro evita que un valor raro llegue a la consulta.
  const propios = config.embudosPropios.filter((n) => Number.isInteger(n) && n >= 0);
  const EMB = propios.length ? `AND detail->>'categoryId' IN (${propios.map((n) => `'${n}'`).join(',')})` : '';
  const q = (sql: string) => p.query(sql);
  try {
    const PROG = `coalesce(nullif(detail->'input'->>'nombre',''), detail->'input'->>'url')`;
    const [
      byType, conv, tools, leadsOk, scoreAgg, intenc, sentim, perDay, embudo, asesores,
      topProg, topInteres, porTipo, porFacultad, gaps, capturaConvs, escalConvs, scoreBuckets, porHora,
      respWhatsapp, convDurWhatsapp, callDur,
    ] = await Promise.all([
      q(`SELECT type, count(*)::int c FROM audit_log WHERE true ${W} GROUP BY type`),
      // Diálogos que el bot ATENDIÓ: exige al menos un turno suyo. Antes contaba cualquier diálogo
      // con actividad registrada, incluidos aquellos donde el bot se mantuvo en silencio porque un
      // asesor escribió primero — y el tooltip de la tarjeta ya decía "que el bot atendió", así que
      // la etiqueta era correcta y la consulta no la cumplía. Medido al corregirlo: 7 de 190 en
      // Postgrados (3,7%) y 1 de 67 en Carver. También es el denominador de las tasas de captura y
      // escalamiento, que quedan igual de bien medidas.
      q(`SELECT count(DISTINCT dialog_id)::int c FROM audit_log WHERE type='turn' AND dialog_id IS NOT NULL ${W}`),
      q(`SELECT detail->>'name' name, count(*)::int c FROM audit_log WHERE type='tool_call' ${W} GROUP BY 1`),
      // DISTINCT dialog_id: registrar_interes_crm se llama varias veces por conversación (una por
      // cada dato nuevo — nombre, email, teléfono, programa), así que contar filas infla el número
      // muy por encima de los leads/negociaciones reales tocados (bug real: 12 "leads" con solo 5-6
      // conversaciones detrás). Mismo criterio que ya usaba capturaConvs más abajo.
      q(`SELECT count(DISTINCT dialog_id)::int c FROM audit_log WHERE type='tool_call' AND detail->>'name'='registrar_interes_crm' AND detail->>'ok'='true' ${W}`),
      q(`SELECT round(avg((detail->>'score')::numeric))::int avg, count(*)::int c FROM audit_log WHERE type='lead_score' AND detail->>'score' IS NOT NULL ${W}`),
      q(`SELECT detail->>'intencion' k, count(*)::int c FROM audit_log WHERE type='lead_score' AND detail->>'intencion' IS NOT NULL ${W} GROUP BY 1`),
      q(`SELECT detail->>'sentimiento' k, count(*)::int c FROM audit_log WHERE type='lead_score' AND detail->>'sentimiento' IS NOT NULL ${W} GROUP BY 1`),
      q(`SELECT to_char(date_trunc('day', ts AT TIME ZONE '${TZ_PANEL}'),'YYYY-MM-DD') d, count(*)::int c FROM audit_log WHERE type='turn' AND ts >= now() - interval '7 days' GROUP BY 1 ORDER BY 1`),
      q(`SELECT detail->>'categoryId' cat, count(*)::int c, round(avg((detail->>'score')::numeric))::int avg
         FROM audit_log WHERE type='lead_score' AND detail->>'categoryId' IS NOT NULL ${W} GROUP BY 1 ORDER BY 2 DESC`),
      // El desglose por asesor se limita a los embudos de la marca. Sin esto aparecían asesores de
      // Postgrados en el panel de Carver: los dos bots comparten portal, el bot evalúa cualquier
      // conversación que le llega, y el responsable de esa negociación puede ser de otro equipo.
      q(`SELECT detail->>'responsableId' id, count(*)::int c, count(DISTINCT dialog_id)::int convs, round(avg((detail->>'score')::numeric))::int avg
         FROM audit_log WHERE type='lead_score' AND detail->>'responsableId' IS NOT NULL AND detail->>'responsableId' NOT IN ('-1','0') ${EMB} ${W} GROUP BY 1 ORDER BY 3 DESC LIMIT 25`),
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
      q(`SELECT extract(hour from ts AT TIME ZONE '${TZ_PANEL}')::int h, count(*)::int c FROM audit_log WHERE type='turn' ${W} GROUP BY 1 ORDER BY 1`),
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
      // Fallas técnicas del período. Antes el panel solo miraba un contador EN MEMORIA que se
      // reiniciaba en cada deploy, así que un error de ayer era invisible hoy (ver audit type='error').
      errores: byTypeMap['error'] ?? 0,
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

/** Una derivación a un asesor: el deal, por qué se derivó y CUÁNDO. La fecha es lo que permite
 *  medir después, contra Bitrix, cuánto tardó un humano en tomar el caso (ver crm/marchaBlanca.ts). */
export type EscaladoRef = { dealId: number; motivo: 'explicito' | 'silencio'; ts: string };

export type MarchaBlancaBotStats = {
  key: string;
  mensajes: number;
  escalamientos: number;
  llamadasIA: number;
  /** Deals escalados a un asesor (best-effort: solo cuando la entidad del CRM ya era un Deal en el
   *  momento de escalar) — para cruzar después con la etapa/matrícula (WON) real en Bitrix. `motivo`
   *  distingue el pedido explícito del cliente/auto-escalado por score ('explicito') del envío por
   *  silencio tras el recordatorio automático ('silencio' — ver ai/seguimiento.ts). Si un mismo deal
   *  tuvo ambos eventos, se prioriza 'silencio' por ser la señal más específica. */
  escalados: EscaladoRef[];
  /** TODOS los deals con los que el bot conversó (>=1 turno), haya escalado o no — más amplio que
   *  `escalados`: cubre cualquier negociación donde el bot trabajó, para verificar matrículas sin
   *  depender de que se haya disparado una escalada (ver Deal #3490881, Katherine: tuvo turnos de
   *  conversación pero su asignación fue manual, nunca pasó por escalar_a_humano). */
  dealsConversados: number[];
  /** Contactos con los que el bot conversó sin que el chat estuviera vinculado a una negociación:
   *  la mitad de las conversaciones quedan así. Se resuelven a sus deals en crm/marchaBlanca.ts. */
  contactosConversados: number[];
};

/**
 * Métricas que vienen 100% de audit_log (Postgres), filtradas por programa.
 *
 * Antes esto calculaba un "SLA de contacto" como el tiempo hasta el primer operator_msg en el mismo
 * diálogo. Esa medición era estructuralmente imposible: una vez que la sesión se transfiere, el bot
 * deja de recibir los mensajes del chat, y además los asesores trabajan por teléfono/correo desde
 * Bitrix, no dentro del chat del bot. Resultado: 10 escalamientos, 0 casos medidos, columna siempre
 * en "—". El seguimiento del asesor ahora se mide contra el CRM (ver crm/marchaBlanca.ts), usando
 * la fecha de derivación que estas consultas devuelven en `escalados[].ts`.
 *
 * `dialogIdsPorPrograma` (opcional): lista de dialog_id YA resuelta por programa (ver
 * crm/marchaBlanca.ts:resolverDialogosPorProgramaPiloto, que cruza contra el UF_PROGRAMA REAL de
 * cada Deal en Bitrix) — mucho más confiable que el texto libre de registrar_interes_crm: cubre
 * deals que YA tenían el programa cargado desde antes (por campaña), donde el bot correctamente no
 * vuelve a registrar ese texto (ver ai/prompt.ts + crm/chat.ts:loadPriorContext), así que el método
 * por texto solo los pierde. Sin este parámetro (p. ej. sin auth de Bitrix disponible), cae al
 * método viejo (texto) como aproximación.
 */
export async function dbMarchaBlancaBot(range = 'all', dialogIdsPorPrograma?: Map<string, string[]>): Promise<MarchaBlancaBotStats[]> {
  if (!pool) return [];
  const p = pool;
  const interval = range in RANGE_INTERVAL ? RANGE_INTERVAL[range] : null;
  const W = interval ? `AND ts >= now() - interval '${interval}'` : ''; // interval viene de whitelist

  const out: MarchaBlancaBotStats[] = [];
  for (const prog of config.marchaBlancaProgramas) {
    const matchPat = `%${prog.match}%`;
    const excludePat = prog.exclude ? `%${prog.exclude}%` : null;
    const resueltos = dialogIdsPorPrograma?.get(prog.key);
    const dialogFilterSql = resueltos
      ? `dialog_id = ANY($1::text[])`
      : `dialog_id IN (
          SELECT DISTINCT dialog_id FROM audit_log
          WHERE type='tool_call' AND detail->>'name'='registrar_interes_crm'
            AND detail->'input'->>'programa_interes' ILIKE $1
            AND ($2::text IS NULL OR detail->'input'->>'programa_interes' NOT ILIKE $2)
            AND dialog_id IS NOT NULL
        )`;
    const dialogParams: unknown[] = resueltos ? [resueltos] : [matchPat, excludePat];
    try {
      const [msgR, escR, callR, escEntR, escSilencioR, conversadosR, contactosR] = await Promise.all([
        p.query(`SELECT count(*)::int c FROM audit_log WHERE type='turn' ${W} AND ${dialogFilterSql}`, dialogParams),
        p.query(
          `SELECT count(*)::int c FROM audit_log
           WHERE ((type='auto_escalation') OR (type='tool_call' AND detail->>'name'='escalar_a_humano')) ${W}
             AND ${dialogFilterSql}`,
          dialogParams,
        ),
        p.query(
          `SELECT count(*)::int c FROM audit_log
           WHERE type='voice_call' ${W}
             AND detail->>'programaInteres' ILIKE $1
             AND ($2::text IS NULL OR detail->>'programaInteres' NOT ILIKE $2)`,
          [matchPat, excludePat],
        ),
        p.query(
          `SELECT crm_entity, min(ts) ts FROM audit_log
           WHERE ((type='auto_escalation') OR (type='tool_call' AND detail->>'name'='escalar_a_humano')) ${W}
             AND crm_entity LIKE 'deal#%'
             AND ${dialogFilterSql}
           GROUP BY crm_entity`,
          dialogParams,
        ),
        p.query(
          `SELECT crm_entity, min(ts) ts FROM audit_log
           WHERE type='seguimiento_transferencia' ${W}
             AND crm_entity LIKE 'deal#%'
             AND ${dialogFilterSql}
           GROUP BY crm_entity`,
          dialogParams,
        ),
        p.query(
          `SELECT DISTINCT crm_entity FROM audit_log
           WHERE type='turn'
             AND crm_entity LIKE 'deal#%'
             AND ${dialogFilterSql}`,
          dialogParams,
        ),
        // La MITAD de las conversaciones del bot quedan vinculadas a un CONTACTO, no a una
        // negociación (75 y 75, medido en producción). Contando solo las de negociación, la tabla
        // por programa mostraba la mitad del trabajo real. Estos contactos se resuelven a sus deals
        // en crm/marchaBlanca.ts.
        p.query(
          `SELECT DISTINCT crm_entity FROM audit_log
           WHERE type='turn'
             AND crm_entity LIKE 'contact#%'
             AND ${dialogFilterSql}`,
          dialogParams,
        ),
      ]);
      const idDe = (r: any) => Number(String(r.crm_entity).split('#')[1]);
      // Fecha de derivación por deal: si tuvo escalada explícita Y envío por silencio, vale la más
      // temprana — es el momento en que el caso quedó realmente en manos de un asesor.
      const tsPorDeal = new Map<number, string>();
      const recolectar = (rows: any[]) => {
        const ids: number[] = [];
        for (const r of rows) {
          const id = idDe(r);
          if (!(id > 0)) continue;
          ids.push(id);
          const ts = new Date(r.ts).toISOString();
          const previo = tsPorDeal.get(id);
          if (!previo || ts < previo) tsPorDeal.set(id, ts);
        }
        return ids;
      };
      const silencioIds = new Set(recolectar(escSilencioR.rows));
      const explicitoIds = recolectar(escEntR.rows);
      const todosIds = new Set([...explicitoIds, ...silencioIds]);
      const escalados: EscaladoRef[] = [...todosIds].map((dealId) => ({
        dealId,
        motivo: silencioIds.has(dealId) ? 'silencio' : 'explicito',
        ts: tsPorDeal.get(dealId)!,
      }));
      const dealsConversados = conversadosR.rows.map(idDe).filter((n: number) => n > 0);
      const contactosConversados = contactosR.rows.map(idDe).filter((n: number) => n > 0);
      out.push({
        key: prog.key,
        mensajes: msgR.rows[0]?.c ?? 0,
        escalamientos: escR.rows[0]?.c ?? 0,
        llamadasIA: callR.rows[0]?.c ?? 0,
        escalados,
        dealsConversados,
        contactosConversados,
      });
    } catch (e) {
      log.warn('dbMarchaBlancaBot falló', { err: String(e), programa: prog.key });
      out.push({
        key: prog.key,
        mensajes: 0,
        escalamientos: 0,
        llamadasIA: 0,
        escalados: [],
        dealsConversados: [],
        contactosConversados: [],
      });
    }
  }
  return out;
}

/** Arma "campo ILIKE %match% [AND campo NOT ILIKE %exclude%] OR ..." para CUALQUIERA de los
 *  programas piloto — para el reporte combinado (los 2 programas juntos, no uno por fila como en
 *  dbMarchaBlancaBot). `campo` es la expresión SQL ya lista (ej. detail->>'programaInteres'). */
function filtroCualquierProgramaPiloto(campo: string): { sql: string; params: string[] } {
  const partes: string[] = [];
  const params: string[] = [];
  for (const prog of config.marchaBlancaProgramas) {
    params.push(`%${prog.match}%`);
    let clause = `${campo} ILIKE $${params.length}`;
    if (prog.exclude) {
      params.push(`%${prog.exclude}%`);
      clause += ` AND ${campo} NOT ILIKE $${params.length}`;
    }
    partes.push(`(${clause})`);
  }
  return { sql: partes.length ? partes.join(' OR ') : 'FALSE', params };
}

/** Todos los pares (dialog_id, deal_id) distintos donde el bot dejó >=1 turno vinculado a un Deal —
 *  de CUALQUIER programa (sin filtrar todavía). Es la base para el cruce contra el UF_PROGRAMA REAL
 *  de cada Deal (ver crm/marchaBlanca.ts:resolverDialogosPorProgramaPiloto): cubre los diálogos que
 *  el método por texto (registrar_interes_crm) pierde porque el Deal ya tenía el programa cargado
 *  desde antes y el bot correctamente no lo volvió a registrar. */
export async function dbDialogosConDeal(): Promise<Array<{ dialogId: string; dealId: number }>> {
  if (!pool) return [];
  try {
    const r = await pool.query(
      `SELECT DISTINCT dialog_id, split_part(crm_entity, '#', 2)::int AS deal_id
       FROM audit_log WHERE type='turn' AND crm_entity LIKE 'deal#%' AND dialog_id IS NOT NULL`,
    );
    return r.rows.map((row: any) => ({ dialogId: row.dialog_id as string, dealId: row.deal_id as number }));
  } catch (e) {
    log.warn('dbDialogosConDeal falló', { err: String(e) });
    return [];
  }
}

/** Diálogos que en ALGÚN momento pasaron el texto de este programa a registrar_interes_crm — señal
 *  complementaria a dbDialogosConDeal (cubre leads que nunca llegaron a tener un Deal). */
export async function dbDialogosPorTextoPrograma(prog: { match: string; exclude?: string }): Promise<string[]> {
  if (!pool) return [];
  try {
    const r = await pool.query(
      `SELECT DISTINCT dialog_id FROM audit_log
       WHERE type='tool_call' AND detail->>'name'='registrar_interes_crm'
         AND detail->'input'->>'programa_interes' ILIKE $1
         AND ($2::text IS NULL OR detail->'input'->>'programa_interes' NOT ILIKE $2)
         AND dialog_id IS NOT NULL`,
      [`%${prog.match}%`, prog.exclude ? `%${prog.exclude}%` : null],
    );
    return r.rows.map((row: any) => row.dialog_id as string);
  } catch (e) {
    log.warn('dbDialogosPorTextoPrograma falló', { err: String(e), match: prog.match });
    return [];
  }
}

export type PilotoProgresoReal = {
  leadsIngresados: number;
  leadsAtendidos: number;
  mensajes: number;
  leadsAltaIntencion: number;
  llamadasSolicitadas: number;
  llamadasRealizadas: number;
  llamadasContestadas: number;
  minutosLlamadas: number;
  escalamientos: number;
  escalamientosPorSilencio: number;
  escalamientosExplicitos: number;
};

const PILOTO_VACIO: PilotoProgresoReal = {
  leadsIngresados: 0, leadsAtendidos: 0, mensajes: 0, leadsAltaIntencion: 0, llamadasSolicitadas: 0,
  llamadasRealizadas: 0, llamadasContestadas: 0, minutosLlamadas: 0, escalamientos: 0,
  escalamientosPorSilencio: 0, escalamientosExplicitos: 0,
};

/**
 * Métricas REALES (audit_log), combinando los 2 programas piloto en UN solo total — para comparar
 * contra la proyección del correo de lanzamiento de la marcha blanca (ver routes/dashboard.ts).
 * Distinto de dbMarchaBlancaBot (que da 1 fila POR programa): acá es la suma de ambos, tal como se
 * presentó la proyección ("284 leads", no "142 + 142").
 *
 * `dialogIds` (opcional): lista YA resuelta de dialog_id de CUALQUIERA de los 2 programas piloto
 * (unión, ver crm/marchaBlanca.ts:resolverDialogosPorProgramaPiloto — cruza contra el UF_PROGRAMA
 * real de cada Deal, no solo el texto de registrar_interes_crm). Sin este parámetro cae al método
 * viejo por texto (menos confiable — ver el docblock de dbMarchaBlancaBot para el porqué).
 * "leadsIngresados" y "leadsAtendidos" quedan iguales a propósito: el bot responde SIEMPRE de
 * inmediato al primer mensaje (arquitectura "bot-first"), así que todo lead que entra queda atendido.
 */
export async function dbPilotoProgresoReal(dialogIds?: string[]): Promise<PilotoProgresoReal> {
  if (!pool) return PILOTO_VACIO;
  const p = pool;
  const progUF = filtroCualquierProgramaPiloto(`detail->'input'->>'programa_interes'`);
  const progInteres = filtroCualquierProgramaPiloto(`detail->>'programaInteres'`);
  const dialogWhere = dialogIds
    ? `dialog_id = ANY($1::text[])`
    : `dialog_id IN (
        SELECT DISTINCT dialog_id FROM audit_log
        WHERE type='tool_call' AND detail->>'name'='registrar_interes_crm'
          AND dialog_id IS NOT NULL AND (${progUF.sql})
      )`;
  const dialogParams: unknown[] = dialogIds ? [dialogIds] : progUF.params;

  try {
    const [atendidosR, mensajesR, altaR, llamSolR, vozR, escR, escSilR] = await Promise.all([
      p.query(`SELECT count(DISTINCT dialog_id)::int c FROM audit_log WHERE type='turn' AND ${dialogWhere}`, dialogParams),
      p.query(`SELECT count(*)::int c FROM audit_log WHERE type='turn' AND ${dialogWhere}`, dialogParams),
      p.query(
        `SELECT count(DISTINCT dialog_id)::int c FROM audit_log
         WHERE type='lead_score' AND detail->>'intencion'='alta' AND ${dialogWhere}`,
        dialogParams,
      ),
      p.query(
        `SELECT count(*)::int c FROM audit_log
         WHERE type='tool_call' AND detail->>'name'='solicitar_llamada' AND detail->>'ok'='true'
           AND ${dialogWhere}`,
        dialogParams,
      ),
      p.query(
        `SELECT count(*)::int total,
                count(*) FILTER (WHERE coalesce((detail->>'duration')::int, 0) > 0)::int contestadas,
                coalesce(sum(coalesce((detail->>'duration')::int, 0)), 0)::int seg_total
         FROM audit_log WHERE type='voice_call' AND (${progInteres.sql})`,
        progInteres.params,
      ),
      p.query(
        `SELECT count(*)::int c FROM audit_log
         WHERE ((type='auto_escalation') OR (type='tool_call' AND detail->>'name'='escalar_a_humano'))
           AND ${dialogWhere}`,
        dialogParams,
      ),
      p.query(`SELECT count(*)::int c FROM audit_log WHERE type='seguimiento_transferencia' AND ${dialogWhere}`, dialogParams),
    ]);

    // "escalamientos" (auto_escalation/escalar_a_humano) y "seguimiento_transferencia" son 2 caminos
    // DISTINTOS hacia un asesor humano (pedido explícito/score vs. silencio) — se SUMAN para el total,
    // no se resta uno del otro.
    const escalamientosExplicitos = escR.rows[0]?.c ?? 0;
    const escalamientosPorSilencio = escSilR.rows[0]?.c ?? 0;
    const leadsAtendidos = atendidosR.rows[0]?.c ?? 0;
    return {
      leadsIngresados: leadsAtendidos,
      leadsAtendidos,
      mensajes: mensajesR.rows[0]?.c ?? 0,
      leadsAltaIntencion: altaR.rows[0]?.c ?? 0,
      llamadasSolicitadas: llamSolR.rows[0]?.c ?? 0,
      llamadasRealizadas: vozR.rows[0]?.total ?? 0,
      llamadasContestadas: vozR.rows[0]?.contestadas ?? 0,
      minutosLlamadas: Math.round((vozR.rows[0]?.seg_total ?? 0) / 60),
      escalamientos: escalamientosExplicitos + escalamientosPorSilencio,
      escalamientosPorSilencio,
      escalamientosExplicitos,
    };
  } catch (e) {
    log.warn('dbPilotoProgresoReal falló', { err: String(e) });
    return PILOTO_VACIO;
  }
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
                count(*) FILTER (WHERE created_at AT TIME ZONE '${TZ_PANEL}' >= date_trunc('day', now() AT TIME ZONE '${TZ_PANEL}'))::int hoy
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

/** Todos los diálogos registrados, con su volumen y tipos de evento. Para distinguir conversaciones
 *  reales de pruebas antes de borrar nada (ver dbBorrarDialogos). */
export async function dbDialogosTodos(): Promise<any[]> {
  if (!pool) return [];
  try {
    const r = await pool.query(
      `SELECT dialog_id,
              count(*)::int eventos,
              count(*) FILTER (WHERE type='turn')::int turnos,
              min(ts) inicio, max(ts) fin,
              max(crm_entity) crm_entity,
              (array_agg(detail->>'message' ORDER BY ts ASC) FILTER (WHERE type='turn'))[1] AS primer_mensaje
       FROM audit_log WHERE dialog_id IS NOT NULL
       GROUP BY dialog_id ORDER BY max(ts) DESC`,
    );
    return r.rows;
  } catch (err) {
    log.warn('dbDialogosTodos falló', { err: String(err) });
    return [];
  }
}

/**
 * Borra TODOS los eventos de los diálogos indicados. Irreversible.
 *
 * Existe porque las conversaciones de prueba inflan las métricas del panel: con 4 conversaciones
 * registradas y 3 de ellas pruebas, cualquier porcentaje que se calcule es ficción. Exige ids
 * EXPLÍCITOS a propósito — nada de prefijos ni comodines — para que no se pueda vaciar la auditoría
 * por accidente con un patrón más amplio de lo previsto.
 */
export async function dbBorrarDialogos(dialogIds: string[]): Promise<{ borrados: number; dialogos: string[] }> {
  if (!pool || !dialogIds.length) return { borrados: 0, dialogos: [] };
  const r = await pool.query(`DELETE FROM audit_log WHERE dialog_id = ANY($1::text[])`, [dialogIds]);
  log.warn('audit_log: diálogos borrados a mano', { dialogos: dialogIds, filas: r.rowCount });
  return { borrados: r.rowCount ?? 0, dialogos: dialogIds };
}

// ─────────────────────────── Tokens consumidos (persistentes) ───────────────────────────
//
// El contador de tokens vivía SOLO en memoria (obs/metrics), así que se reiniciaba en cada
// despliegue. Para el informe del piloto hubo que extrapolar el costo desde una semana suelta: con
// una docena de despliegues en un día, el número del panel no representaba nada.
//
// No se escribe una fila por llamada al modelo —serían miles— sino un acumulado cada minuto. En el
// peor caso (caída justo antes de un volcado) se pierde hasta un minuto de consumo.
let bufIn = 0;
let bufOut = 0;
let flushPendiente: NodeJS.Timeout | null = null;
const FLUSH_MS = 60_000;

async function volcarTokens(): Promise<void> {
  flushPendiente = null;
  const entrada = bufIn;
  const salida = bufOut;
  bufIn = 0;
  bufOut = 0;
  if (!pool || (entrada === 0 && salida === 0)) return;
  try {
    await pool.query(`INSERT INTO audit_log (type, detail) VALUES ('tokens', $1::jsonb)`, [
      JSON.stringify({ in: entrada, out: salida }),
    ]);
  } catch (err) {
    log.warn('dbAcumularTokens: no se pudo persistir el consumo', { err: String(err) });
  }
}

/** Suma el consumo de una respuesta del modelo al acumulado que se persiste cada minuto. */
export function dbAcumularTokens(usage: any): void {
  if (!usage || !pool) return;
  bufIn += Number(usage.input_tokens) || 0;
  bufOut += Number(usage.output_tokens) || 0;
  if (!flushPendiente) flushPendiente = setTimeout(() => void volcarTokens(), FLUSH_MS).unref?.() ?? setTimeout(() => void volcarTokens(), FLUSH_MS);
}

/** Tokens consumidos en el período, desde Postgres. null si no hay registros (p. ej. antes de que
 *  esto existiera), para que el panel pueda caer al contador en memoria y no mostrar un cero falso. */
export async function dbTokensSumados(range = 'all'): Promise<{ in: number; out: number } | null> {
  if (!pool) return null;
  const interval = range in RANGE_INTERVAL ? RANGE_INTERVAL[range] : null;
  const W = interval ? `AND ts >= now() - interval '${interval}'` : '';
  try {
    const r = await pool.query(
      `SELECT coalesce(sum((detail->>'in')::bigint), 0)::bigint entrada,
              coalesce(sum((detail->>'out')::bigint), 0)::bigint salida,
              count(*)::int filas
       FROM audit_log WHERE type='tokens' ${W}`,
    );
    const f = r.rows[0];
    if (!f || Number(f.filas) === 0) return null;
    return { in: Number(f.entrada), out: Number(f.salida) };
  } catch (err) {
    log.warn('dbTokensSumados falló', { err: String(err) });
    return null;
  }
}

/** Todas las derivaciones del bot a una persona, sin filtrar por programa: el deal, cuándo se derivó
 *  y por qué vía. Es la base de la vista por asesor del panel (crm/vistaAsesores.ts), que a
 *  diferencia de la marcha blanca no depende de que haya programas piloto configurados. */
export async function dbDerivaciones(range = 'all'): Promise<Array<{ dealId: number; ts: string; dialogId: string | null; motivo: string }>> {
  if (!pool) return [];
  const interval = range in RANGE_INTERVAL ? RANGE_INTERVAL[range] : null;
  const W = interval ? `AND ts >= now() - interval '${interval}'` : ''; // interval viene de whitelist
  try {
    const r = await pool.query(
      `SELECT crm_entity,
              min(ts) ts,
              (array_agg(dialog_id ORDER BY ts))[1] dialog_id,
              (array_agg(type ORDER BY ts))[1] motivo
       FROM audit_log
       WHERE (type='auto_escalation'
              OR type='seguimiento_transferencia'
              OR (type='tool_call' AND detail->>'name'='escalar_a_humano' AND detail->>'ok'='true'))
         AND crm_entity LIKE 'deal#%' ${W}
       GROUP BY crm_entity`,
    );
    return r.rows
      .map((x: any) => ({
        dealId: Number(String(x.crm_entity).slice(5)),
        ts: x.ts,
        dialogId: x.dialog_id ?? null,
        motivo: x.motivo === 'seguimiento_transferencia' ? 'silencio' : x.motivo === 'auto_escalation' ? 'score' : 'pedido',
      }))
      .filter((x) => Number.isFinite(x.dealId) && x.dealId > 0);
  } catch (err) {
    log.warn('dbDerivaciones falló', { err: String(err) });
    return [];
  }
}

/**
 * Cuándo derivó el bot esta negociación por última vez, en epoch ms, o null.
 *
 * La marca en Redis solo existe para lo que el bot movió DESPUÉS de desplegar esa protección; esto
 * cubre lo anterior, que es justo donde está el problema hoy: negociaciones derivadas hace días que
 * un asesor ya tomó. Se usa `max(ts)`, la derivación más reciente, no la primera.
 */
export async function dbUltimaDerivacion(dealId: number): Promise<number | null> {
  if (!pool || !Number.isFinite(dealId) || dealId <= 0) return null;
  try {
    const r = await pool.query(
      `SELECT max(ts) ts
       FROM audit_log
       WHERE crm_entity = $1
         AND (type='auto_escalation'
              OR type='seguimiento_transferencia'
              OR type='derivacion'
              OR (type='tool_call' AND detail->>'name'='escalar_a_humano' AND detail->>'ok'='true'))`,
      [`deal#${dealId}`],
    );
    const ts = r.rows?.[0]?.ts;
    return ts ? new Date(ts).getTime() : null;
  } catch (err) {
    log.warn('dbUltimaDerivacion falló', { err: String(err), dealId });
    return null;
  }
}

/** Transcripciones de las conversaciones con actividad en las últimas `horas`, para la revisión
 *  automática (ai/revisionDiaria.ts). Una fila por diálogo, con el diálogo completo ya armado. */
export async function dbTranscripcionesRecientes(
  horas = 24,
  limite = 40,
): Promise<Array<{ dialogId: string; crmEntity: string | null; turnos: number; fin: string; texto: string }>> {
  if (!pool) return [];
  const h = Math.max(1, Math.min(168, Math.round(horas))); // se interpola en SQL: se acota a un entero sano
  try {
    const r = await pool.query(
      `SELECT dialog_id,
              count(*)::int turnos,
              max(ts) fin,
              (array_agg(crm_entity) FILTER (WHERE crm_entity IS NOT NULL))[1] crm_entity,
              string_agg(
                'Cliente: ' || coalesce(detail->>'message','') || E'\nBot: ' || coalesce(detail->>'reply',''),
                E'\n' ORDER BY ts
              ) texto
       FROM audit_log
       WHERE type='turn' AND dialog_id IS NOT NULL AND ts >= now() - interval '${h} hours'
       GROUP BY dialog_id
       ORDER BY max(ts) DESC
       LIMIT $1`,
      [limite],
    );
    return r.rows.map((x: any) => ({
      dialogId: x.dialog_id,
      crmEntity: x.crm_entity ?? null,
      turnos: x.turnos,
      fin: x.fin,
      texto: x.texto ?? '',
    }));
  } catch (err) {
    log.warn('dbTranscripcionesRecientes falló', { err: String(err) });
    return [];
  }
}

/** Hallazgos de la revisión automática, para mostrarlos en el panel. */
export async function dbHallazgosRecientes(limit = 30): Promise<any[]> {
  if (!pool) return [];
  try {
    const r = await pool.query(
      `SELECT ts, dialog_id, crm_entity, detail
       FROM audit_log WHERE type='revision_hallazgo'
       ORDER BY ts DESC LIMIT $1`,
      [limit],
    );
    return r.rows.map((x: any) => ({
      ts: x.ts,
      dialogId: x.dialog_id,
      crmEntity: x.crm_entity,
      tipo: x.detail?.tipo ?? '',
      gravedad: x.detail?.gravedad ?? '',
      detalle: x.detail?.detalle ?? '',
    }));
  } catch (err) {
    log.warn('dbHallazgosRecientes falló', { err: String(err) });
    return [];
  }
}

/** Cuándo entró el último mensaje de un cliente, en minutos. null si no hay base o nunca hubo uno.
 *  Es la señal de vida del canal: la usa la alarma de silencio (ai/vigilanciaCanal.ts). */
export async function dbMinutosDesdeUltimoTurno(): Promise<number | null> {
  if (!pool) return null;
  try {
    const r = await pool.query(`SELECT max(ts) ultimo FROM audit_log WHERE type='turn'`);
    const ultimo = r.rows[0]?.ultimo;
    if (!ultimo) return null;
    return Math.round((Date.now() - new Date(ultimo).getTime()) / 60000);
  } catch (err) {
    log.warn('dbMinutosDesdeUltimoTurno falló', { err: String(err) });
    return null;
  }
}

/**
 * Resultado del primer contacto: de los mensajes enviados, a cuántos contestaron.
 *
 * La respuesta se mide como una conversación del bot con ESA negociación posterior al envío. Es el
 * único número del caso de negocio que no conocíamos: todo lo demás (costo por país, volumen) es
 * calculable de antemano, pero cuánta gente responde no lo sabe nadie hasta probarlo.
 */
export async function dbResultadoPrimerContacto(
  horasVentana = 48,
): Promise<Array<{ plantilla: string; enviados: number; respondieron: number }>> {
  if (!pool) return [];
  const h = Math.max(1, Math.min(720, Math.round(horasVentana)));
  try {
    const r = await pool.query(
      `WITH envios AS (
         SELECT crm_entity, min(ts) enviado_en, coalesce(detail->>'plantilla','(sin registrar)') plantilla
         FROM audit_log
         WHERE type='primer_contacto' AND detail->>'ok'='true' AND crm_entity IS NOT NULL
         GROUP BY crm_entity, coalesce(detail->>'plantilla','(sin registrar)')
       )
       SELECT e.plantilla,
              count(*)::int enviados,
              count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM audit_log t
                WHERE t.type='turn' AND t.crm_entity = e.crm_entity
                  AND t.ts > e.enviado_en
                  AND t.ts <= e.enviado_en + interval '${h} hours'
              ))::int respondieron
       FROM envios e
       GROUP BY e.plantilla
       ORDER BY enviados DESC`,
    );
    return r.rows.map((x: any) => ({ plantilla: x.plantilla, enviados: x.enviados, respondieron: x.respondieron }));
  } catch (err) {
    log.warn('dbResultadoPrimerContacto falló', { err: String(err) });
    return [];
  }
}

/**
 * Conversaciones que el bot atendió, se enfriaron y ya no se pueden retomar con texto libre.
 *
 * El seguimiento automático solo alcanza dentro de las 24 horas de la última interacción; pasado
 * eso WhatsApp exige plantilla. Esta gente es el público más barato de recuperar: ya habló, ya
 * mostró interés y ya dejó datos — a diferencia del primer contacto, donde nadie dijo nada todavía.
 */
export async function dbConversacionesFrias(
  diasMin = 3,
  diasMax = 45,
  limite = 100,
): Promise<Array<{ dialogId: string; dealId: number; ultimoTurno: string; turnos: number }>> {
  if (!pool) return [];
  const min = Math.max(1, Math.min(365, Math.round(diasMin)));
  const max = Math.max(min + 1, Math.min(365, Math.round(diasMax)));
  try {
    const r = await pool.query(
      `SELECT dialog_id,
              (array_agg(crm_entity) FILTER (WHERE crm_entity LIKE 'deal#%'))[1] ent,
              max(ts) ultimo,
              count(*)::int turnos
       FROM audit_log
       WHERE type='turn' AND dialog_id IS NOT NULL
       GROUP BY dialog_id
       HAVING max(ts) < now() - interval '${min} days'
          AND max(ts) > now() - interval '${max} days'
       ORDER BY max(ts) DESC
       LIMIT $1`,
      [limite],
    );
    return r.rows
      .filter((x: any) => x.ent)
      .map((x: any) => ({
        dialogId: x.dialog_id,
        dealId: Number(String(x.ent).slice(5)),
        ultimoTurno: x.ultimo,
        turnos: x.turnos,
      }))
      .filter((x) => Number.isFinite(x.dealId) && x.dealId > 0);
  } catch (err) {
    log.warn('dbConversacionesFrias falló', { err: String(err) });
    return [];
  }
}

/**
 * Cómo vienen saliendo los envíos proactivos (primer contacto y reactivación) en las últimas horas.
 *
 * Es lo más cerca que se puede estar de la "salud del número" sin acceso al WhatsApp Manager: Meta
 * no nos expone la calificación de calidad a través de ChatApp, pero cuando un número empieza a ser
 * limitado, o una plantilla deja de estar aprobada, lo que se ve es que los envíos fallan. Un
 * repunte de errores es el síntoma observable de ese problema.
 */
export async function dbEnviosRecientes(horas = 24): Promise<{ total: number; fallidos: number; errores: string[] }> {
  const vacio = { total: 0, fallidos: 0, errores: [] as string[] };
  if (!pool) return vacio;
  const h = Math.max(1, Math.min(168, Math.round(horas)));
  try {
    const r = await pool.query(
      `SELECT count(*)::int total,
              count(*) FILTER (WHERE detail->>'ok' = 'false')::int fallidos,
              (array_agg(DISTINCT left(detail->>'error', 120)) FILTER (WHERE detail->>'error' IS NOT NULL))[1:3] errores
       FROM audit_log
       WHERE type IN ('primer_contacto','reactivacion') AND ts >= now() - interval '${h} hours'`,
    );
    const f = r.rows[0] ?? {};
    return { total: f.total ?? 0, fallidos: f.fallidos ?? 0, errores: (f.errores ?? []).filter(Boolean) };
  } catch (err) {
    log.warn('dbEnviosRecientes falló', { err: String(err) });
    return vacio;
  }
}
