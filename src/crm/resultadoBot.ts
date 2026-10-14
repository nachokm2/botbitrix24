import { callCrm } from '../bitrix/client';
import { dbDialogosConDeal, dbDerivaciones } from '../store/db';
import { config } from '../config';
import type { Auth } from '../store';
import { log } from '../log';

/**
 * En qué terminaron las negociaciones que el bot atendió.
 *
 * Hasta ahora esto solo existía para Postgrados, atado al scorecard de los dos programas piloto.
 * Carver no tiene piloto configurado, así que esa sección quedaba oculta y no había forma de ver
 * cuántas de las conversaciones del bot terminaron en matrícula — justamente el número que decide
 * si todo esto vale la pena.
 *
 * Se cuenta sobre las negociaciones que el bot TOCÓ: aquellas con las que conversó al menos un
 * turno, más las que derivó. No es "todas las matrículas del embudo": atribuirse las que el bot
 * nunca vio sería inflar el resultado.
 */

const LOTE = 50;

export type ResultadoBot = {
  atendidas: number;
  ganadas: number;
  perdidas: number;
  abiertas: number;
  montoGanado: number;
  porEtapa: Array<{ etapa: string; nombre: string; n: number; ganada: boolean }>;
};

const VACIO: ResultadoBot = { atendidas: 0, ganadas: 0, perdidas: 0, abiertas: 0, montoGanado: 0, porEtapa: [] };

/** ¿Esta etapa cuenta como cerrada con éxito? Configurable porque "ganada" no es solo :WON — en
 *  Carver, "Pagado" es un desenlace tan bueno como "Matriculado" y vive en otra etapa. */
function esGanada(stage: string): boolean {
  if (config.stagesGanadas.length) return config.stagesGanadas.includes(stage);
  return /:WON$/.test(stage);
}

export async function resultadoDelBot(auth: Auth): Promise<ResultadoBot> {
  const conversados = (await dbDialogosConDeal()).map((x) => x.dealId);
  const derivados = (await dbDerivaciones('all')).map((x) => x.dealId);
  const ids = [...new Set([...conversados, ...derivados])].filter((n) => Number.isFinite(n) && n > 0);
  if (!ids.length) return VACIO;

  const deals: Array<Record<string, any>> = [];
  for (let i = 0; i < ids.length; i += LOTE) {
    try {
      const filas = await callCrm<Array<Record<string, any>>>(
        'crm.deal.list',
        {
          filter: { '@ID': ids.slice(i, i + LOTE) },
          select: ['ID', 'STAGE_ID', 'CATEGORY_ID', 'OPPORTUNITY', 'CLOSED'],
        },
        auth,
      );
      for (const d of Array.isArray(filas) ? filas : []) deals.push(d);
    } catch (e) {
      log.warn('resultadoDelBot: no se pudo leer un lote', { err: String(e) });
    }
  }
  // Solo los embudos de esta marca: el bot se topa con negociaciones de otros equipos y contarlas
  // acá se atribuiría matrículas ajenas.
  const propios = config.embudosPropios.length
    ? deals.filter((d) => config.embudosPropios.includes(Number(d.CATEGORY_ID ?? -1)))
    : deals;
  if (!propios.length) return VACIO;

  const nombre = new Map<string, string>();
  for (const cat of new Set(propios.map((d) => Number(d.CATEGORY_ID ?? -1)))) {
    try {
      const r: any = await callCrm('crm.status.list', { filter: { ENTITY_ID: `DEAL_STAGE_${cat}` } }, auth);
      for (const s of Array.isArray(r) ? r : []) nombre.set(String(s.STATUS_ID), String(s.NAME));
    } catch {
      /* sin nombres se muestra el identificador */
    }
  }

  const conteo = new Map<string, number>();
  const out: ResultadoBot = { ...VACIO, atendidas: propios.length, porEtapa: [] };
  for (const d of propios) {
    const stage = String(d.STAGE_ID ?? '');
    conteo.set(stage, (conteo.get(stage) ?? 0) + 1);
    if (esGanada(stage)) {
      out.ganadas++;
      out.montoGanado += Number(d.OPPORTUNITY ?? 0) || 0;
    } else if (/:LOSE$/.test(stage) || d.CLOSED === 'Y') out.perdidas++;
    else out.abiertas++;
  }
  out.porEtapa = [...conteo.entries()]
    .map(([etapa, n]) => ({ etapa, nombre: nombre.get(etapa) ?? etapa, n, ganada: esGanada(etapa) }))
    .sort((a, b) => b.n - a.n);
  return out;
}
