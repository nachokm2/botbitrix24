import { callCrm, callCrmEnvelope } from '../bitrix/client';
import { config, type MarchaBlancaPrograma } from '../config';
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
  /** Negociaciones que el BOT trabajó (conversó o derivó). NO es el total del programa en el
   *  portal: ese conteo no se puede hacer sin arriesgar timeouts (ver comentario en el scorecard). */
  dealsALaFecha: number;
  /** Leads que ENTRARON al programa desde el inicio del piloto (todos, no solo los del bot). null si
   *  el conteo falló. Es el denominador honesto para "cuántos de los que llegaron atendió el bot". */
  leadsCreados: number | null;
  matriculados: number;
  /** En la etapa a la que el bot promueve con score alto + datos completos (BITRIX_STAGE_MAP.alto,
   *  "Postulantes" en Diplomados). Es el paso previo a la matrícula. */
  postulantes: number;
  /** Matriculados sobre las negociaciones trabajadas por el bot. */
  pctCierre: number;
  /** Promedio de los montos REALES de las matrículas; null si todavía no hay ninguna. */
  ticketPromedio: number | null;
  /** De las trabajadas, cuántas ya existían antes de que arrancara la marcha blanca. */
  dealsAntiguos: number;
  dealsNuevos: number;
  escaladosConDeal: number;
  escaladosMatriculados: number;
  escaladosDetalle: EscaladoDetalle[];
  negociacionesDetalle: NegociacionDetalle[];
};

// NOTA: acá vivían baseFilter/countDeals/precioListaPrograma. Se eliminaron al dejar de contar los
// deals del programa en todo el portal: countDeals usaba `start:-1`, que en este portal devuelve
// total:0 en cuanto el filtro lleva un "%" sobre el UF de programa — devolvía ceros silenciosos. Y
// precioListaPrograma servía de relleno del ticket promedio, que hacía pasar el precio de catálogo
// por ingreso medido. Si alguna vez se necesita el total real del programa, hay que paginar (15+ s)
// y hacerlo fuera del refresco del panel.

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
        // BUG REAL: esto pedía los N deals en UNA sola llamada. crm.deal.list devuelve como máximo
        // 50 filas por página, así que con 74 deals en el histórico se resolvían 50 y los 24
        // restantes quedaban sin programa — sus diálogos no entraban en ningún programa piloto y el
        // panel perdía esas negociaciones: mostraba 21 en Terapéutica Familiar cuando eran 29, y 11
        // en Inteligencia Artificial cuando eran 18. Se pide de a 50.
        const programaPorDeal = new Map<number, string>();
        const LOTE = 50;
        for (let i = 0; i < dealIds.length; i += LOTE) {
          const deals = await callCrm<Array<{ ID: string; TITLE?: string; [k: string]: unknown }>>(
            'crm.deal.list',
            { filter: { '@ID': dealIds.slice(i, i + LOTE) }, select: ['ID', config.ufPrograma, 'TITLE'] },
            auth,
          );
          for (const d of Array.isArray(deals) ? deals : []) {
            const texto = String(d[config.ufPrograma] ?? d.TITLE ?? '');
            if (texto) programaPorDeal.set(Number(d.ID), texto);
          }
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


/** Cuántos leads (deals) del programa entraron DESDE que arrancó la marcha blanca. Se pagina de a 50
 *  porque el conteo rápido de Bitrix (`start:-1`) devuelve 0 con este filtro — ver la nota de arriba.
 *  Acotado por fecha tarda 3-6 s, aceptable porque el scorecard se cachea 3 minutos. Devuelve null si
 *  falla: mejor un "—" en el panel que un número inventado. */
async function contarLeadsDelPrograma(
  prog: { nombre: string; match: string; exclude?: string; categoryId: number },
  auth: Auth,
): Promise<number | null> {
  if (!config.ufPrograma) return null;
  const filter: Record<string, unknown> = {
    CATEGORY_ID: prog.categoryId,
    [`%${config.ufPrograma}`]: prog.match,
    '>=DATE_CREATE': config.marchaBlancaStart + 'T00:00:00',
  };
  if (prog.exclude) filter[`!%${config.ufPrograma}`] = prog.exclude;
  try {
    let total = 0;
    let start = 0;
    for (let pagina = 0; pagina < 40; pagina++) {
      const env = await callCrmEnvelope<unknown[]>('crm.deal.list', { filter, select: ['ID'], start }, auth);
      total += (env.result ?? []).length;
      if (env.next == null) return total;
      start = env.next;
    }
    log.warn('contarLeadsDelPrograma: se cortó en 40 páginas', { programa: prog.nombre });
    return total;
  } catch (e) {
    log.warn('contarLeadsDelPrograma falló', { err: String(e), programa: prog.nombre });
    return null;
  }
}


// El conteo real de leads hay que paginarlo (el conteo rápido de Bitrix devuelve 0 con este filtro),
// y a través del limitador de llamadas del cliente eso tarda ~40 s para los 2 programas. Medido: una
// carga fría del panel pasó de 6,6 s a 43,6 s. Por eso NINGUNA petición lo espera: se sirve el último
// valor conocido y, si está vencido, se dispara un refresco en segundo plano para la próxima. La
// primera vez devuelve null (el panel muestra "—") hasta que ese refresco termine.
const LEADS_TTL_MS = 30 * 60 * 1000;
const leadsCache = new Map<string, { at: number; valor: number | null }>();
const leadsRefrescando = new Set<string>();

function leadsCreadosCacheado(prog: MarchaBlancaPrograma, auth: Auth): number | null {
  const previo = leadsCache.get(prog.key);
  const vencido = !previo || Date.now() - previo.at > LEADS_TTL_MS;
  if (vencido && !leadsRefrescando.has(prog.key)) {
    leadsRefrescando.add(prog.key);
    void contarLeadsDelPrograma(prog, auth)
      .then((valor) => leadsCache.set(prog.key, { at: Date.now(), valor }))
      .catch((e) => log.warn('refresco de leads falló', { err: String(e), programa: prog.key }))
      .finally(() => leadsRefrescando.delete(prog.key));
  }
  return previo?.valor ?? null;
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
  botStats: Map<string, { escalados: EscaladoRef[]; dealsConversados: number[]; contactosConversados?: number[] }>,
  auth: Auth,
): Promise<ProgramaScorecard[]> {
  const out: ProgramaScorecard[] = [];
  const etapasPorCategoria = new Map<number, Map<string, string>>();
  for (const prog of config.marchaBlancaProgramas) {
    try {
      if (!config.ufPrograma) throw new Error('BITRIX_UF_PROGRAMA no configurado');
      // Antes acá se contaban TODOS los deals del programa en el portal (countDeals). No funciona:
      // el "start:-1" que usa para contar sin traer filas devuelve total:0 SIEMPRE en este portal en
      // cuanto el filtro incluye el "%" (contiene) sobre el UF de programa — confirmado, el MISMO
      // filtro con paginación normal da el total correcto pero tarda 15+ segundos por el volumen
      // histórico. El resultado era una tabla con "0 leads" y, peor, un "% cierre" de 0% en un
      // programa con 2 matriculados, porque dividía por ese cero.
      //
      // Ahora las 3 columnas se calculan sobre las negociaciones que el bot REALMENTE trabajó (las
      // mismas que ya se consultan más abajo, sin ninguna llamada extra) y se renombraron en el panel
      // para decir exactamente eso. Se mide menos, pero lo que se muestra es cierto.

      // Deals con los que el bot trabajó: unión de escalados (audit_log de escalar_a_humano/
      // auto_escalation/seguimiento_transferencia) y conversados (>=1 turno) — un mismo deal puede
      // venir de ambas fuentes; se consulta UNA sola vez cada uno (set chico, viene de audit_log) en
      // vez de traer TODOS los ganados del portal — evita otra enumeración amplia y lenta.
      const escalados = botStats.get(prog.key)?.escalados ?? [];
      const dealsConversados = botStats.get(prog.key)?.dealsConversados ?? [];
      const motivoPorDeal = new Map(escalados.map((e) => [e.dealId, e.motivo]));
      const todosLosDeals = new Set([...escalados.map((e) => e.dealId), ...dealsConversados]);

      // La MITAD de las conversaciones del bot queda vinculada a un CONTACTO y no a una negociación
      // (75 y 75, medido en producción): el chat se abre antes de que exista el Deal, o Bitrix lo
      // vincula al contacto. Sin esto la tabla mostraba la mitad del trabajo real — y un cliente que
      // sí conversó aparecía como "nunca atendido" (caso real: Fernando Calderón, deal #3530073).
      // Se traen los deals de esos contactos y se quedan SOLO los de este programa.
      const contactos = botStats.get(prog.key)?.contactosConversados ?? [];
      if (contactos.length) {
        const LOTE = 50;
        for (let i = 0; i < contactos.length; i += LOTE) {
          try {
            const deals = await callCrm<Array<{ ID: string; TITLE?: string; [k: string]: unknown }>>(
              'crm.deal.list',
              {
                filter: { '@CONTACT_ID': contactos.slice(i, i + LOTE), CATEGORY_ID: prog.categoryId },
                select: ['ID', config.ufPrograma, 'TITLE'],
              },
              auth,
            );
            for (const d of Array.isArray(deals) ? deals : []) {
              const texto = String(d[config.ufPrograma] ?? d.TITLE ?? '');
              if (texto && programaCoincide(texto, prog)) todosLosDeals.add(Number(d.ID));
            }
          } catch (e) {
            log.warn('scorecard: no se pudieron resolver los deals de los contactos', { err: String(e), programa: prog.key });
          }
        }
      }

      if (todosLosDeals.size && !etapasPorCategoria.has(prog.categoryId)) {
        etapasPorCategoria.set(prog.categoryId, await nombresDeEtapa(prog.categoryId, auth));
      }
      const etapas = etapasPorCategoria.get(prog.categoryId);
      const negociacionesDetalle: NegociacionDetalle[] = [];
      let escaladosMatriculados = 0;
      const montos: number[] = [];
      let dealsAntiguos = 0; // creados ANTES de que arrancara la marcha blanca (venían del embudo)
      // Los deals se traen POR LOTES (crm.deal.list, 50 por página) en vez de uno por uno con
      // crm.deal.get: con ~60 deals eran ~60 llamadas encoladas en el limitador y la carga fría del
      // panel se iba a 33 s. Con lotes son 2 llamadas.
      type DealFila = { TITLE?: string; STAGE_ID?: string; ASSIGNED_BY_ID?: string; OPPORTUNITY?: string; DATE_CREATE?: string };
      const dealsPorId = new Map<number, DealFila>();
      const idsDeals = [...todosLosDeals];
      for (let i = 0; i < idsDeals.length; i += 50) {
        try {
          const filas = await callCrm<Array<DealFila & { ID: string }>>(
            'crm.deal.list',
            {
              filter: { '@ID': idsDeals.slice(i, i + 50) },
              select: ['ID', 'TITLE', 'STAGE_ID', 'ASSIGNED_BY_ID', 'OPPORTUNITY', 'DATE_CREATE'],
            },
            auth,
          );
          for (const f of Array.isArray(filas) ? filas : []) dealsPorId.set(Number(f.ID), f);
        } catch (e) {
          log.warn('scorecard: no se pudo traer un lote de deals', { err: String(e), programa: prog.key });
        }
      }

      for (const dealId of todosLosDeals) {
        try {
          const d = dealsPorId.get(dealId);
          if (!d) continue; // el lote falló o el deal ya no existe
          const matriculadoRef = !!d?.STAGE_ID?.endsWith(':WON');
          // Ya venía del embudo antes del piloto, o es un lead que entró durante la marcha blanca.
          if (d?.DATE_CREATE && d.DATE_CREATE < config.marchaBlancaStart) dealsAntiguos++;
          const motivo = motivoPorDeal.get(dealId) ?? null;
          if (motivo && matriculadoRef) escaladosMatriculados++;
          if (matriculadoRef) {
            const monto = Number(d?.OPPORTUNITY) || 0;
            if (monto > 0) montos.push(monto);
          }
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

      // "matriculados" y "ticket promedio" salen de negociacionesDetalle (deals con los que el bot
      // trabajó, set chico y ya consultado arriba) — NO de un scan amplio de Bitrix (ese es el que
      // tarda 15+ segundos, ver comentario de dealsALaFecha más arriba). Queda con alcance más
      // acotado que antes (solo deals que el bot conversó, no CUALQUIER matrícula del programa desde
      // siempre) pero es un número REAL y rápido en vez de uno amplio que nunca funcionó (daba 0).
      const leadsCreados = leadsCreadosCacheado(prog, auth);
      const matriculados = negociacionesDetalle.filter((n) => n.matriculado).length;
      // "Postulantes" no se busca por nombre de etapa (se puede renombrar en Bitrix): se usa la MISMA
      // etapa a la que el bot promueve por score alto con datos completos, la de BITRIX_STAGE_MAP.
      const etapaPostulante = config.stageMap[String(prog.categoryId)]?.alto ?? '';
      const postulantes = etapaPostulante
        ? negociacionesDetalle.filter((n) => n.stageId === etapaPostulante).length
        : 0;
      const ticketReal = montos.length ? Math.round(montos.reduce((a, b) => a + b, 0) / montos.length) : null;

      const catalogo = matchPrograma(prog.nombre)[0];
      out.push({
        key: prog.key,
        nombre: prog.nombre,
        estado: catalogo?.estado ?? null,
        asesorNorte: prog.asesorNorte,
        asesorSur: prog.asesorSur,
        dealsALaFecha: todosLosDeals.size, // negociaciones que el bot trabajó (ver comentario arriba)
        leadsCreados,
        matriculados,
        postulantes,
        // Se cierra sobre lo trabajado, no sobre un total que no se puede contar. Antes dividía por
        // 0 y mostraba "0% de cierre" en un programa con 2 matriculados.
        pctCierre: todosLosDeals.size ? Math.round((matriculados / todosLosDeals.size) * 100) : 0,
        // Solo el ticket REAL de las matrículas. Antes, sin matrículas, caía al precio de LISTA del
        // catálogo: la columna mostraba $864.000 en un programa con 0 matriculados, como si fuera
        // ingreso medido.
        ticketPromedio: ticketReal,
        dealsAntiguos,
        dealsNuevos: todosLosDeals.size - dealsAntiguos,
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
        leadsCreados: null,
        postulantes: 0,
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
