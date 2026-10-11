import { callCrm } from '../bitrix/client';
import { config } from '../config';
import { dbDerivaciones } from '../store/db';
import { detectarBarridosEnBloque, type MovimientoDeal } from './marchaBlanca';
import { getUsuarios } from './directory';
import type { Auth } from '../store';
import { log } from '../log';

/**
 * Vista por asesor: qué le entregó el bot a cada persona y qué hizo con ello.
 *
 * El scorecard de marcha blanca responde "¿cómo va cada programa?"; esto responde "¿cómo va cada
 * asesor?", que es la pregunta que quedó abierta cuando se vio que 4 de 38 derivaciones habían sido
 * trabajadas: el agregado no dice a quién hay que ayudar. A diferencia de la marcha blanca, no
 * depende de que haya programas piloto configurados, así que sirve igual en las dos marcas.
 */

export type FilaAsesor = {
  id: number;
  nombre: string;
  derivados: number;
  atendidos: number;
  pendientes: number;
  medianaSeg: number | null;
  ultimaDerivacion: string | null;
};

const LOTE = 50; // crm.deal.list devuelve como máximo 50 filas por página

export async function vistaPorAsesor(auth: Auth, range = 'all'): Promise<FilaAsesor[]> {
  const derivaciones = await dbDerivaciones(range);
  if (!derivaciones.length) return [];

  // Un deal puede aparecer una sola vez (la consulta ya agrupa por entidad), así que el set de IDs
  // es el de derivaciones. Se piden de a 50: pedirlos todos juntos devuelve solo la primera página
  // y el resto queda sin responsable — el mismo error que costó 24 negociaciones en el panel.
  const dealsPorId = new Map<number, MovimientoDeal & { ASSIGNED_BY_ID?: string }>();
  const ids = derivaciones.map((d) => d.dealId);
  for (let i = 0; i < ids.length; i += LOTE) {
    try {
      const deals = await callCrm<Array<Record<string, any>>>(
        'crm.deal.list',
        {
          filter: { '@ID': ids.slice(i, i + LOTE) },
          select: ['ID', 'ASSIGNED_BY_ID', 'MOVED_BY_ID', 'MOVED_TIME', 'STAGE_ID'],
        },
        auth,
      );
      for (const d of Array.isArray(deals) ? deals : []) dealsPorId.set(Number(d.ID), d as any);
    } catch (e) {
      log.warn('vistaPorAsesor: crm.deal.list falló para un lote', { err: String(e) });
    }
  }
  if (!dealsPorId.size) return [];

  const automaticos = new Set(config.usuariosAutomaticos);
  const enBarrido = detectarBarridosEnBloque(ids, dealsPorId);

  type Acum = { derivados: number; esperas: number[]; ultima: number };
  const porAsesor = new Map<number, Acum>();

  for (const der of derivaciones) {
    const d = dealsPorId.get(der.dealId);
    if (!d) continue; // la negociación ya no existe o no se pudo leer
    const asesor = Number(d.ASSIGNED_BY_ID ?? 0);
    if (!asesor || automaticos.has(asesor)) continue;

    const acum = porAsesor.get(asesor) ?? { derivados: 0, esperas: [], ultima: 0 };
    acum.derivados++;
    const derivadoEn = new Date(der.ts).getTime();
    if (Number.isFinite(derivadoEn)) acum.ultima = Math.max(acum.ultima, derivadoEn);

    // Mismo criterio que la columna de seguimiento del piloto: mover la etapa cuenta como atención
    // solo si lo hizo una persona, caso por caso, después de la derivación.
    const movidoPor = Number(d.MOVED_BY_ID ?? 0);
    const movido = d.MOVED_TIME ? new Date(d.MOVED_TIME).getTime() : 0;
    const atendido =
      movidoPor &&
      movido &&
      !automaticos.has(movidoPor) &&
      !enBarrido.has(der.dealId) &&
      Number.isFinite(derivadoEn) &&
      movido > derivadoEn;
    if (atendido) acum.esperas.push((movido - derivadoEn) / 1000);

    porAsesor.set(asesor, acum);
  }
  if (!porAsesor.size) return [];

  const nombres = new Map<number, string>();
  try {
    for (const u of await getUsuarios([...porAsesor.keys()], auth)) nombres.set(u.id, u.nombre);
  } catch (e) {
    log.warn('vistaPorAsesor: no se pudieron resolver los nombres', { err: String(e) });
  }

  return [...porAsesor.entries()]
    .map(([id, a]): FilaAsesor => {
      const esperas = a.esperas.sort((x, y) => x - y);
      return {
        id,
        nombre: nombres.get(id) ?? `Asesor ${id}`,
        derivados: a.derivados,
        atendidos: esperas.length,
        pendientes: a.derivados - esperas.length,
        medianaSeg: esperas.length ? Math.round(esperas[Math.floor(esperas.length / 2)]) : null,
        ultimaDerivacion: a.ultima ? new Date(a.ultima).toISOString() : null,
      };
    })
    // Primero quien tiene más casos sin trabajar: es la fila sobre la que hay algo que hacer.
    .sort((x, y) => y.pendientes - x.pendientes || y.derivados - x.derivados);
}
