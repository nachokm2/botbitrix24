import type { Request, Response } from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { snapshot } from '../obs/metrics';
import { dbMetricsSummary, dbRecentAudit, dbEnabled, dbMarchaBlancaBot, dbPilotoProgresoReal, dbErroresRecientes } from '../store/db';
import { kvKind } from '../store/kv';
import { getState } from '../store';
import { getUsuarios } from '../crm/directory';
import { bitrixMarchaBlancaScorecard, resolverDialogosPorProgramaPiloto, type ProgramaScorecard } from '../crm/marchaBlanca';
import { config } from '../config';

const RANGES = ['today', '7d', '30d', 'all'];

// Proyección del piloto ("marcha blanca"), tal como se presentó en el correo de lanzamiento a la
// jefatura (2 programas, ~142 leads/mes c/u). Son valores de REFERENCIA para comparar contra los
// reales del mes, no resultados comprometidos — ver dbPilotoProgresoReal (audit_log) +
// bitrixMarchaBlancaScorecard (matrículas reales en Bitrix) para el lado "real".
const PILOTO_PROYECCION = {
  programas: 2,
  leadsEsperados: 284,
  primeraRespuestaAutomatica: 284,
  mensajesIA: 1800,
  llamadas: 70,
  minutosLlamadas: 500,
  llamadasContestadasMin: 55,
  llamadasContestadasMax: 60,
  escalamientosMin: 40,
  escalamientosMax: 50,
  leadsAltaIntencionMin: 20,
  leadsAltaIntencionMax: 30,
  // Del correo original (175-420) menos la máquina virtual GCP (30-80): no hay una VM de GCP
  // encendida para las llamadas de WhatsApp, ese componente no aplica.
  costoUsdMin: 145,
  costoUsdMax: 340,
};

// El scorecard de marcha blanca mezcla conteos en vivo de Bitrix (leads/deals) — cachear unos minutos
// evita golpear la API en cada refresco del panel (15s) mientras alguien lo tiene abierto. La
// resolución de diálogos por programa (cruce contra el UF_PROGRAMA real de cada Deal, ver
// crm/marchaBlanca.ts:resolverDialogosPorProgramaPiloto) comparte el mismo TTL: usa el mismo
// crm.deal.list en lote, así que cachearla junto al scorecard evita duplicar esa llamada.
let marchaBlancaCache: { at: number; data: ProgramaScorecard[]; dialogosPorPrograma: Map<string, string[]> } | null = null;
const MARCHA_BLANCA_TTL_MS = 3 * 60 * 1000;

/** JSON con métricas de negocio (persistentes) + técnicas (en memoria) + actividad reciente. */
export async function metricsSummary(req: Request, res: Response) {
  const range = RANGES.includes(String(req.query.range)) ? String(req.query.range) : '7d';
  const st = await getState();

  // Diálogos REALES por programa piloto (cruce contra Bitrix) — antes de dbMarchaBlancaBot/
  // dbPilotoProgresoReal, que ahora los reciben resueltos en vez de aproximar por texto libre.
  let dialogosPorPrograma: Map<string, string[]> | undefined;
  if (st.auth) {
    if (marchaBlancaCache && Date.now() - marchaBlancaCache.at < MARCHA_BLANCA_TTL_MS) {
      dialogosPorPrograma = marchaBlancaCache.dialogosPorPrograma;
    } else {
      try {
        dialogosPorPrograma = await resolverDialogosPorProgramaPiloto(st.auth);
      } catch {
        dialogosPorPrograma = marchaBlancaCache?.dialogosPorPrograma;
      }
    }
  }
  const dialogosCombinados = dialogosPorPrograma ? [...new Set([...dialogosPorPrograma.values()].flat())] : undefined;

  const [live, agg, recent, erroresRecientes, marchaBlancaBot, pilotoReal] = await Promise.all([
    snapshot(),
    dbMetricsSummary(range),
    dbRecentAudit(15),
    dbErroresRecientes(15),
    dbMarchaBlancaBot('all', dialogosPorPrograma), // el scorecard del piloto siempre es "desde siempre" (no sigue el selector Hoy/7d/30d)
    dbPilotoProgresoReal(dialogosCombinados), // proyección vs. real del piloto (correo de lanzamiento) — también "desde siempre"
  ]);

  // Scorecard de marcha blanca: combina lo nativo del bot (mensajes/escalamientos/llamadas IA/SLA,
  // siempre disponible) con leads/deals reales de Bitrix (requiere auth; cacheado — ver MARCHA_BLANCA_TTL_MS).
  let marchaBlancaCrm: ProgramaScorecard[] | null = null;
  if (st.auth) {
    if (marchaBlancaCache && Date.now() - marchaBlancaCache.at < MARCHA_BLANCA_TTL_MS) {
      marchaBlancaCrm = marchaBlancaCache.data;
    } else {
      try {
        const botByKey = new Map(marchaBlancaBot.map((b) => [b.key, { escalados: b.escalados, dealsConversados: b.dealsConversados }]));
        marchaBlancaCrm = await bitrixMarchaBlancaScorecard(botByKey, st.auth);
        marchaBlancaCache = { at: Date.now(), data: marchaBlancaCrm, dialogosPorPrograma: dialogosPorPrograma ?? new Map() };
      } catch {
        marchaBlancaCrm = marchaBlancaCache?.data ?? null;
      }
    }
  }
  // Matrículas y "leads que avanzan" REALES de los 2 programas piloto (combinados) — solo entre las
  // negociaciones donde el bot efectivamente conversó/escaló (negociacionesDetalle), no cualquier
  // matrícula del embudo (esas pueden venir de otros canales/campañas sin que el bot haya participado).
  const negociacionesPiloto = (marchaBlancaCrm ?? []).flatMap((p) => p.negociacionesDetalle);
  const matriculasReales = negociacionesPiloto.filter((n) => n.matriculado).length;
  const avanzandoReales = negociacionesPiloto.filter((n) => !n.matriculado && !n.stageId?.endsWith(':LOSE')).length;

  const crmByKey = new Map((marchaBlancaCrm ?? []).map((r) => [r.key, r]));
  const marchaBlanca = config.marchaBlancaProgramas.map((prog) => ({
    key: prog.key,
    nombre: prog.nombre,
    asesorNorte: prog.asesorNorte ?? null,
    asesorSur: prog.asesorSur ?? null,
    crm: crmByKey.get(prog.key) ?? null, // null = sin auth de Bitrix o falló la consulta (ver logs)
    bot: marchaBlancaBot.find((b) => b.key === prog.key) ?? null,
  }));

  // Resuelve el nombre de cada asesor responsable (por su ASSIGNED_BY_ID) para el desglose "Por asesor".
  if (agg?.porAsesor?.length) {
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
    erroresRecientes, // fallas técnicas con motivo y etapa, para poder accionarlas desde el panel
    funnelLabels: config.funnelLabels,
    marchaBlanca,
    marchaBlancaStart: config.marchaBlancaStart,
    bitrixDomain: st.auth?.domain ?? null, // para armar el link directo a cada deal (ver "Deals escalados a asesor")
    piloto: {
      proyeccion: PILOTO_PROYECCION,
      real: {
        ...pilotoReal,
        matriculas: matriculasReales,
        leadsAvanzando: avanzandoReales,
        costoUsdClaude: cost, // el único componente que el bot puede medir solo (los demás: ver factura/panel de uso de cada proveedor)
        costoUsdRailway: config.costoUsdRailway, // actualizado a mano (COSTO_USD_RAILWAY) desde Project → Usage en Railway
      },
    },
  });
}

/** Página del panel (se embebe dentro de Bitrix24 vía placement, y también funciona standalone).
 *  El HTML/CSS/JS viven en archivos estáticos (public/dashboard/) — ver ALT-Baja-7 de la auditoría. */
export function dashboardPage(_req: Request, res: Response) {
  res.set('Content-Type', 'text/html; charset=utf-8').send(DASHBOARD_HTML);
}

const DASHBOARD_HTML = readFileSync(fileURLToPath(new URL('../../public/dashboard/index.html', import.meta.url)), 'utf8');
