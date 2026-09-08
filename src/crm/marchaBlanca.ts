import { callCrm, callCrmEnvelope } from '../bitrix/client';
import { config } from '../config';
import { matchPrograma } from '../core/condicionesComerciales';
import { log } from '../log';
import type { Auth } from '../store';
import { dbDialogosConDeal, dbDialogosPorTextoPrograma, type EscaladoRef } from '../store/db';
import type { BitrixStatus, BitrixStatusListResponse } from '../bitrix/types';
import { programaCoincide } from './asignacionAsesores';

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

/** Un deal escalado a un asesor, con su etapa ACTUAL en Bitrix — para que se pueda ver dónde quedó
 *  cada uno (no solo el conteo agregado de escaladosMatriculados) y si ya matriculó. */
export type EscaladoDetalle = {
  dealId: number;
  titulo: string;
  asesor: string | null;
  motivo: 'explicito' | 'silencio';
  stageId: string | null;
  stageNombre: string | null;
  matriculado: boolean;
};

/** Un deal donde el bot conversó con el cliente — sea o no que haya escalado a un asesor. Más amplio
 *  que EscaladoDetalle: cubre cualquier negociación que el bot trabajó (ej. Deal #3490881, Katherine:
 *  tuvo conversación pero su asignación fue manual, nunca pasó por escalar_a_humano). */
export type NegociacionDetalle = {
  dealId: number;
  titulo: string;
  asesor: string | null;
  stageId: string | null;
  stageNombre: string | null;
  matriculado: boolean;
  escalado: boolean;
  motivo: 'explicito' | 'silencio' | null;
};

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
  escaladosDetalle: EscaladoDetalle[];
  negociacionesDetalle: NegociacionDetalle[];
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

/**
 * Resuelve, para cada programa piloto, el conjunto REAL de dialog_id que le pertenecen. Combina 2
 * señales:
 *  (a) el texto que el bot pasó a registrar_interes_crm (cubre leads que nunca llegaron a tener un
 *      Deal, así que Bitrix no tiene dónde guardar el programa);
 *  (b) el programa REAL (UF_PROGRAMA) de cada Deal con el que el bot conversó — imprescindible
 *      porque cuando un Deal YA tenía el programa cargado desde antes (creado por una campaña de
 *      marketing), loadPriorContext le dice al bot que NO vuelva a preguntarlo/registrarlo — así que
 *      (a) por sí sola pierde esos diálogos (caso real: 93 de 106 diálogos reales del bot no tenían
 *      NINGÚN registrar_interes_crm con programa_interes, precisamente por esto).
 * Se usa UNA sola llamada a crm.deal.list (filtro "@ID") para los N deals distintos, no N llamadas.
 */
export async function resolverDialogosPorProgramaPiloto(auth: Auth): Promise<Map<string, string[]>> {
  const out = new Map<string, Set<string>>();
  for (const prog of config.marchaBlancaProgramas) out.set(prog.key, new Set());

  await Promise.all(
    config.marchaBlancaProgramas.map(async (prog) => {
      const dialogIds = await dbDialogosPorTextoPrograma(prog);
      for (const d of dialogIds) out.get(prog.key)!.add(d);
    }),
  );

  if (config.ufPrograma) {
    const pares = await dbDialogosConDeal();
    const dealIds = [...new Set(pares.map((x) => x.dealId))];
    if (dealIds.length) {
      try {
        const deals = await callCrm<Array<{ ID: string; TITLE?: string; [k: string]: unknown }>>(
          'crm.deal.list',
          { filter: { '@ID': dealIds }, select: ['ID', config.ufPrograma, 'TITLE'] },
          auth,
        );
        const programaPorDeal = new Map<number, string>();
        for (const d of Array.isArray(deals) ? deals : []) {
          const texto = String(d[config.ufPrograma] ?? d.TITLE ?? '');
          if (texto) programaPorDeal.set(Number(d.ID), texto);
        }
        for (const { dialogId, dealId } of pares) {
          const texto = programaPorDeal.get(dealId);
          if (!texto) continue;
          for (const prog of config.marchaBlancaProgramas) {
            if (programaCoincide(texto, prog)) out.get(prog.key)!.add(dialogId);
          }
        }
      } catch (e) {
        log.warn('resolverDialogosPorProgramaPiloto: crm.deal.list falló', { err: String(e) });
      }
    }
  }

  return new Map([...out.entries()].map(([key, set]) => [key, [...set]]));
}

/** Nombre legible de cada etapa (STATUS_ID → NAME) de un embudo — se cachea por categoryId dentro
 *  de una misma corrida del scorecard (los 2 programas piloto comparten embudo casi siempre). */
async function nombresDeEtapa(categoryId: number, auth: Auth): Promise<Map<string, string>> {
  try {
    const entityId = categoryId === 0 ? 'DEAL_STAGE' : `DEAL_STAGE_${categoryId}`;
    const r = (await callCrm<BitrixStatusListResponse>('crm.status.list', { filter: { ENTITY_ID: entityId } }, auth)) as BitrixStatusListResponse;
    const arr: BitrixStatus[] = Array.isArray(r) ? r : (r?.result ?? []);
    return new Map(arr.filter((s) => s.STATUS_ID && s.NAME).map((s) => [s.STATUS_ID as string, s.NAME as string]));
  } catch (e) {
    log.warn('nombresDeEtapa falló', { err: String(e), categoryId });
    return new Map();
  }
}

export async function bitrixMarchaBlancaScorecard(
  botStats: Map<string, { escalados: EscaladoRef[]; dealsConversados: number[] }>,
  auth: Auth,
): Promise<ProgramaScorecard[]> {
  const out: ProgramaScorecard[] = [];
  const etapasPorCategoria = new Map<number, Map<string, string>>();
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

      // Deals con los que el bot trabajó: unión de escalados (audit_log de escalar_a_humano/
      // auto_escalation/seguimiento_transferencia) y conversados (>=1 turno) — un mismo deal puede
      // venir de ambas fuentes; se consulta UNA sola vez cada uno (set chico, viene de audit_log) en
      // vez de traer TODOS los ganados — evita otra enumeración amplia.
      const escalados = botStats.get(prog.key)?.escalados ?? [];
      const dealsConversados = botStats.get(prog.key)?.dealsConversados ?? [];
      const motivoPorDeal = new Map(escalados.map((e) => [e.dealId, e.motivo]));
      const todosLosDeals = new Set([...escalados.map((e) => e.dealId), ...dealsConversados]);

      if (todosLosDeals.size && !etapasPorCategoria.has(prog.categoryId)) {
        etapasPorCategoria.set(prog.categoryId, await nombresDeEtapa(prog.categoryId, auth));
      }
      const etapas = etapasPorCategoria.get(prog.categoryId);
      const negociacionesDetalle: NegociacionDetalle[] = [];
      let escaladosMatriculados = 0;
      for (const dealId of todosLosDeals) {
        try {
          const d = await callCrm<{ TITLE?: string; STAGE_ID?: string; ASSIGNED_BY_ID?: string }>(
            'crm.deal.get',
            { id: dealId },
            auth,
          );
          const matriculadoRef = !!d?.STAGE_ID?.endsWith(':WON');
          const motivo = motivoPorDeal.get(dealId) ?? null;
          if (motivo && matriculadoRef) escaladosMatriculados++;
          const asesor =
            d?.ASSIGNED_BY_ID != null && prog.asesorNorteId != null && Number(d.ASSIGNED_BY_ID) === prog.asesorNorteId
              ? (prog.asesorNorte ?? null)
              : d?.ASSIGNED_BY_ID != null && prog.asesorSurId != null && Number(d.ASSIGNED_BY_ID) === prog.asesorSurId
                ? (prog.asesorSur ?? null)
                : (d?.ASSIGNED_BY_ID ?? null);
          negociacionesDetalle.push({
            dealId,
            titulo: d?.TITLE ?? `Deal #${dealId}`,
            asesor,
            stageId: d?.STAGE_ID ?? null,
            stageNombre: d?.STAGE_ID ? (etapas?.get(d.STAGE_ID) ?? d.STAGE_ID) : null,
            matriculado: matriculadoRef,
            escalado: motivo != null,
            motivo,
          });
        } catch {
          /* deal borrado o inaccesible: no cuenta */
        }
      }
      const escaladosDetalle: EscaladoDetalle[] = negociacionesDetalle
        .filter((n) => n.motivo != null)
        .map((n) => ({
          dealId: n.dealId,
          titulo: n.titulo,
          asesor: n.asesor,
          motivo: n.motivo as 'explicito' | 'silencio',
          stageId: n.stageId,
          stageNombre: n.stageNombre,
          matriculado: n.matriculado,
        }));

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
        escaladosConDeal: escalados.length,
        escaladosMatriculados,
        escaladosDetalle,
        negociacionesDetalle,
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
        escaladosDetalle: [],
        negociacionesDetalle: [],
      });
    }
  }
  return out;
}
