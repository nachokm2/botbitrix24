import { callCrm } from '../bitrix/client';
import { dbDerivaciones } from '../store/db';
import { config } from '../config';
import type { Auth } from '../store';
import { log } from '../log';

/**
 * Mover a la etapa de "derivadas" las negociaciones que el bot ya derivó antes de que esa etapa
 * existiera.
 *
 * Vive acá y no en un script porque la base de datos de cada marca es interna a su servicio: el
 * cruce entre las derivaciones registradas y el estado actual en Bitrix solo se puede hacer donde
 * corre el bot. Lo mismo que pasó con las plantillas de ChatApp.
 *
 * Lo que NO se toca está declarado explícitamente: mover a "Derivados Bot" una negociación que va
 * en "Pendiente de Pago" o "Firma contrato" la saca de su etapa real y nadie se entera — el caso
 * desaparece del lugar donde alguien lo estaba trabajando.
 */

const LOTE = 50;

export type Movimiento = { dealId: number; de: string; a: string; titulo: string };
export type PlanMovimiento = {
  derivaciones: number;
  reparto: Array<{ etapa: string; nombre: string; n: number; protegida: boolean }>;
  mover: Movimiento[];
  omitidas: Array<{ motivo: string; n: number }>;
};

export async function planDeMovimiento(auth: Auth, protegidas: Set<string>): Promise<PlanMovimiento> {
  const derivaciones = await dbDerivaciones('all');
  const ids = [...new Set(derivaciones.map((d) => d.dealId))];
  const plan: PlanMovimiento = { derivaciones: ids.length, reparto: [], mover: [], omitidas: [] };
  if (!ids.length) return plan;

  const deals = new Map<number, { stage: string; categoria: number; titulo: string; cerrada: boolean }>();
  for (let i = 0; i < ids.length; i += LOTE) {
    try {
      const filas = await callCrm<Array<Record<string, any>>>(
        'crm.deal.list',
        { filter: { '@ID': ids.slice(i, i + LOTE) }, select: ['ID', 'STAGE_ID', 'CATEGORY_ID', 'TITLE', 'CLOSED'] },
        auth,
      );
      for (const d of Array.isArray(filas) ? filas : []) {
        deals.set(Number(d.ID), {
          stage: String(d.STAGE_ID ?? ''),
          categoria: Number(d.CATEGORY_ID ?? -1),
          titulo: String(d.TITLE ?? '').slice(0, 60),
          cerrada: d.CLOSED === 'Y',
        });
      }
    } catch (e) {
      log.warn('planDeMovimiento: no se pudo leer un lote', { err: String(e) });
    }
  }

  // Nombres de etapa, para que el reparto se lea sin traducir identificadores a mano.
  const nombre = new Map<string, string>();
  for (const cat of new Set([...deals.values()].map((d) => d.categoria))) {
    try {
      const r: any = await callCrm('crm.status.list', { filter: { ENTITY_ID: `DEAL_STAGE_${cat}` } }, auth);
      for (const s of Array.isArray(r) ? r : []) nombre.set(String(s.STATUS_ID), String(s.NAME));
    } catch {
      /* sin nombres se opera igual */
    }
  }

  const conteoEtapa = new Map<string, number>();
  const omit = new Map<string, number>();
  const marcar = (m: string) => omit.set(m, (omit.get(m) ?? 0) + 1);

  for (const dealId of ids) {
    const d = deals.get(dealId);
    if (!d) {
      marcar('no se pudo leer en Bitrix');
      continue;
    }
    conteoEtapa.set(d.stage, (conteoEtapa.get(d.stage) ?? 0) + 1);
    const destino = config.stageDerivado[d.categoria];
    if (!destino) marcar(`embudo ${d.categoria} sin etapa configurada`);
    else if (d.stage === destino) marcar('ya está en la etapa');
    else if (d.cerrada || /:(WON|LOSE)$/.test(d.stage)) marcar('cerrada (ganada o perdida)');
    else if (protegidas.has(d.stage)) marcar('etapa protegida');
    else plan.mover.push({ dealId, de: d.stage, a: destino, titulo: d.titulo });
  }

  plan.reparto = [...conteoEtapa.entries()]
    .map(([etapa, n]) => ({ etapa, nombre: nombre.get(etapa) ?? etapa, n, protegida: protegidas.has(etapa) }))
    .sort((a, b) => b.n - a.n);
  plan.omitidas = [...omit.entries()].map(([motivo, n]) => ({ motivo, n })).sort((a, b) => b.n - a.n);
  return plan;
}

export async function aplicarMovimiento(auth: Auth, mover: Movimiento[]): Promise<{ ok: number; fallos: string[] }> {
  let ok = 0;
  const fallos: string[] = [];
  for (const m of mover) {
    try {
      // Se relee justo antes: si alguien la movió mientras corríamos, no se pisa su decisión.
      const d: any = await callCrm('crm.deal.get', { id: m.dealId, select: ['STAGE_ID'] }, auth);
      if (String(d?.STAGE_ID ?? '') !== m.de) {
        fallos.push(`deal#${m.dealId}: cambió de etapa mientras corría`);
        continue;
      }
      await callCrm('crm.deal.update', { id: m.dealId, fields: { STAGE_ID: m.a } }, auth);
      ok++;
    } catch (e) {
      fallos.push(`deal#${m.dealId}: ${String(e).slice(0, 110)}`);
    }
  }
  log.info('movimiento de derivadas aplicado', { ok, fallos: fallos.length });
  return { ok, fallos };
}
