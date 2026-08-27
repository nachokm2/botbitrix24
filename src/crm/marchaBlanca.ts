import { callCrm, callCrmEnvelope } from '../bitrix/client';
import { config } from '../config';
import { matchPrograma } from '../core/condicionesComerciales';
import { log } from '../log';
import type { Auth } from '../store';

// Scorecard del piloto ("marcha blanca"): mezcla datos EN VIVO de Bitrix (leads/deals reales, no
// pasan por audit_log) con las métricas nativas del bot (audit_log, ver store/db.ts:dbMarchaBlancaBot).
// Se filtra por el campo UF_PROGRAMA del Deal (fuente de verdad una vez que Bitrix asigna asesor;
// ver crm/crmWrite.ts) — un lead que aún NO se convirtió a Deal no tiene este campo y no se cuenta acá.
//
// IMPORTANTE (aprendido a la fuerza): este portal tiene millones de deals históricos. Enumerar filas
// (paginar) sobre un filtro amplio (embudo Diplomados completo) es lento y arriesga OPERATION_TIME_LIMIT
// o timeouts del proceso. Por eso TODO acá usa conteos (`start:-1`, Bitrix devuelve `total` sin traer
// filas) salvo el promedio de ticket, que solo pagina los deals GANADOS *desde el arranque del piloto*
// (un set chico y acotado por fecha).

export type ProgramaScorecard = {
  key: string;
  nombre: string;
  estado: string | null;
  asesorNorte?: string;
  asesorSur?: string;
  dealsALaFecha: number;
  matriculados: number;
  pctCierre: number;
  ticketPromedio: number | null;
  dealsAntiguos: number;
  dealsNuevos: number;
  escaladosConDeal: number;
  escaladosMatriculados: number;
};

function baseFilter(nombrePrograma: string, exclude: string | undefined, categoryId: number): Record<string, unknown> {
  // CATEGORY_ID primero: acota a un embudo (indexado) antes del filtro de texto en el UF de programa.
  const filter: Record<string, unknown> = { CATEGORY_ID: categoryId, [`%${config.ufPrograma}`]: nombrePrograma };
  if (exclude) filter[`!%${config.ufPrograma}`] = exclude;
  return filter;
}

/** Cuenta deals que matchean `filter` sin traer filas (Bitrix: start:-1 → solo `total`). */
async function countDeals(filter: Record<string, unknown>, auth: Auth): Promise<number> {
  const env = await callCrmEnvelope<unknown[]>('crm.deal.list', { filter, select: ['ID'], start: -1 }, auth);
  return env.total ?? 0;
}

/** Precio de lista (fallback) cuando aún no hay matrículas reales para promediar. */
function precioListaPrograma(nombre: string): number | null {
  const m = matchPrograma(nombre);
  const p = m.find((x) => x.total != null) ?? m[0];
  return p?.total ?? null;
}

export async function bitrixMarchaBlancaScorecard(
  botStats: Map<string, { escaladosDealIds: number[] }>,
  auth: Auth,
): Promise<ProgramaScorecard[]> {
  const out: ProgramaScorecard[] = [];
  for (const prog of config.marchaBlancaProgramas) {
    try {
      if (!config.ufPrograma) throw new Error('BITRIX_UF_PROGRAMA no configurado');
      const filter = baseFilter(prog.nombre, prog.exclude, prog.categoryId);
      const wonFilter = { ...filter, '%STAGE_ID': 'WON' };
      const antiguosFilter = { ...filter, '<DATE_CREATE': config.marchaBlancaStart + 'T00:00:00' };

      const [dealsALaFecha, matriculados, dealsAntiguos] = await Promise.all([
        countDeals(filter, auth),
        countDeals(wonFilter, auth),
        countDeals(antiguosFilter, auth),
      ]);

      // Ticket promedio REAL: solo los deals GANADOS desde el arranque del piloto (set chico, se puede
      // paginar sin riesgo). Antes de esa fecha no hay forma barata de traer los montos uno a uno.
      const wonSincePilotoFilter = { ...wonFilter, '>=DATE_CREATE': config.marchaBlancaStart + 'T00:00:00' };
      const montos: number[] = [];
      let wStart = 0;
      for (let page = 0; page < 20; page++) {
        // tope 20 páginas (1000 deals ganados desde el piloto) — de sobra para un piloto de 2 programas
        const env = await callCrmEnvelope<Array<{ ID: string; OPPORTUNITY: string }>>(
          'crm.deal.list',
          { filter: wonSincePilotoFilter, select: ['ID', 'OPPORTUNITY'], start: wStart },
          auth,
        );
        for (const d of env.result ?? []) {
          const n = Number(d.OPPORTUNITY) || 0;
          if (n > 0) montos.push(n);
        }
        if (env.next == null) break;
        wStart = env.next;
      }
      const ticketReal = montos.length ? Math.round(montos.reduce((a, b) => a + b, 0) / montos.length) : null;

      // Escalados que matricularon: consulta cada deal escalado (set chico, viene de audit_log) en vez
      // de traer TODOS los ganados — evita otra enumeración amplia.
      const escaladosDealIds = botStats.get(prog.key)?.escaladosDealIds ?? [];
      let escaladosMatriculados = 0;
      for (const id of escaladosDealIds) {
        try {
          const d = await callCrm<{ STAGE_ID?: string }>('crm.deal.get', { id }, auth);
          if (d?.STAGE_ID?.endsWith(':WON')) escaladosMatriculados++;
        } catch {
          /* deal borrado o inaccesible: no cuenta */
        }
      }

      const catalogo = matchPrograma(prog.nombre)[0];
      out.push({
        key: prog.key,
        nombre: prog.nombre,
        estado: catalogo?.estado ?? null,
        asesorNorte: prog.asesorNorte,
        asesorSur: prog.asesorSur,
        dealsALaFecha,
        matriculados,
        pctCierre: dealsALaFecha ? Math.round((matriculados / dealsALaFecha) * 100) : 0,
        ticketPromedio: ticketReal ?? precioListaPrograma(prog.nombre),
        dealsAntiguos,
        dealsNuevos: dealsALaFecha - dealsAntiguos,
        escaladosConDeal: escaladosDealIds.length,
        escaladosMatriculados,
      });
    } catch (e) {
      log.warn('bitrixMarchaBlancaScorecard falló', { err: String(e), programa: prog.key });
      out.push({
        key: prog.key,
        nombre: prog.nombre,
        estado: null,
        asesorNorte: prog.asesorNorte,
        asesorSur: prog.asesorSur,
        dealsALaFecha: 0,
        matriculados: 0,
        pctCierre: 0,
        ticketPromedio: null,
        dealsAntiguos: 0,
        dealsNuevos: 0,
        escaladosConDeal: 0,
        escaladosMatriculados: 0,
      });
    }
  }
  return out;
}
