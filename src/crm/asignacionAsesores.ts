import { callCrm } from '../bitrix/client';
import { esEmbudoPropio, filtroEmbudosPropios } from './embudos';
import { getUsuarios } from './directory';
import { perteneceAlEquipo } from './equipo';
import { audit } from '../obs/audit';
import { config, type MarchaBlancaPrograma } from '../config';
import { getRedisClient, once } from '../store/kv';
import { log } from '../log';
import type { Auth } from '../store';
import type { CrmEntities } from './entities';
import type { BitrixTaskAddResult } from '../bitrix/types';

// Asignación por turno (round-robin Norte/Sur) + tarea de seguimiento, SOLO para los 2 programas
// piloto de la marcha blanca. Se dispara: (a) apenas el deal tiene el programa de interés capturado
// (motivo='automatico', ver crmWrite.ts) — el disparador MÁS temprano y el más común; (b) cuando el
// bot escala a un humano (motivo='escalado'); (c) si el cliente queda en silencio tras el
// recordatorio (motivo='silencio', ver ai/seguimiento.ts). El lock por deal asegura que solo el
// PRIMERO de estos 3 disparadores en llegar hace la asignación real — los siguientes no reasignan.
//
// Por qué existe esto en vez de confiar en la regla de "asesor por oferta" de Bitrix (la que ya
// corre sola cuando el deal entra al embudo/etapa de Asignación, ver crmWrite.ts:
// camposAsignacionSiCorresponde): se confirmó en producción que esa regla NO reasigna un deal que
// ya tiene un responsable real (ej. quedó en quien "recogió" la conversación en Open Lines) — caso
// real: deal #3490881 (Katherine), quedó en Rodrigo Palma en vez de Joaquín/Eduardo pese a pasar
// por la etapa correcta. Además, el responsable POR DEFECTO de esos embudos no es un asesor real
// (confirmado por el usuario) — sin un disparador temprano, cualquier deal que el bot conversa sin
// llegar a escalar se queda ahí para siempre. Para los 2 programas del piloto, donde SÍ necesitamos
// que la asignación sea confiable y pareja entre los 2 asesores, el bot mismo asigna directo — sin
// depender de esa regla externa. Para el resto del catálogo (todos los demás programas) sigue
// rigiendo Bitrix.

/** ¿El texto (programa_interes, TITLE, o UF_PROGRAMA real de un Deal) corresponde a este programa
 *  piloto? Exportada para reutilizar el MISMO criterio de match donde haga falta cruzar contra el
 *  programa real de Bitrix (ver crm/marchaBlanca.ts:resolverDialogosPorProgramaPiloto). */
export function programaCoincide(texto: string, prog: MarchaBlancaPrograma): boolean {
  const t = texto.toLowerCase();
  if (!t.includes(prog.match.toLowerCase())) return false;
  if (prog.exclude && t.includes(prog.exclude.toLowerCase())) return false;
  return true;
}

/**
 * Si el deal pertenece a uno de los 2 programas piloto: asigna el turno que corresponda (alterna
 * Norte/Sur, contador en Redis) y crea una tarea de seguimiento con plazo
 * (config.asignacionTareaHoras) para ese asesor. Se ejecuta UNA sola vez por deal (lock en Redis) —
 * si el bot vuelve a escalar la misma conversación (reconexión, nuevo mensaje tras escalar, o el
 * cliente quedó en silencio tras el recordatorio automático) no reasigna ni duplica la tarea. No
 * hace nada si el deal no es de uno de los 2 programas piloto, si faltan los IDs de asesor en la
 * config, o si no hay Redis (no hay forma confiable de alternar sin estado compartido entre réplicas).
 *
 * `motivo` solo cambia el texto de la tarea que ve el asesor:
 *  - 'automatico': el deal recién tiene el programa de interés capturado — el cliente sigue
 *    conversando con el bot, no hay nada urgente que hacer todavía, es solo para que el deal quede
 *    con el asesor correcto desde temprano (en vez de con el responsable por defecto).
 *  - 'escalado' (default): el cliente pidió hablar con alguien / el score disparó el auto-escalado.
 *  - 'silencio': el cliente dejó de responder tras el recordatorio automático (ver ai/seguimiento.ts)
 *    — NO es una transferencia urgente, es solo para que el asesor pueda contactarlo temprano.
 *
 * Devuelve `true` solo si REALMENTE asignó y creó la tarea (para que el llamador pueda distinguir
 * "se derivó a un asesor" de "no aplicaba" — ej. programa fuera del piloto, o no había ningún deal
 * — en vez de contarlo como una derivación real; ver ai/seguimiento.ts).
 */
export async function asignarAsesorPorTurno(
  entities: CrmEntities,
  auth: Auth,
  motivo: 'automatico' | 'escalado' | 'silencio' = 'escalado',
  opts: { crearTarea?: boolean } = {},
): Promise<boolean> {
  if (!config.ufPrograma) return false;
  const redis = getRedisClient();
  if (!redis) return false;
  const crearTarea = opts.crearTarea !== false;

  // Si el chat solo está vinculado a un Contacto (sin Deal) — pasa cuando el auto-CRM nativo de Open
  // Lines todavía no actualizó el vínculo del chat, o el cliente escaló muy rápido, antes de que el
  // bot llegara a resolver el Deal — busca directo en Bitrix si YA existe un Deal para ese contacto
  // (puede existir aunque el chat no lo sepa todavía). Sin esto, ese cliente se queda sin asesor
  // asignado para siempre (caso real: contacto #2398581, Terapia Familiar).
  let dealId = entities.deal;
  if (!dealId && entities.contact) {
    try {
      // El filtro de embudo es imprescindible acá: sin él se tomaba la negociación MÁS RECIENTE del
      // contacto, de cualquier embudo, y una conversación de Carver terminaba reasignando un lead
      // de Postgrados que no tenía nada que ver.
      const r = await callCrm<Array<{ ID: string }>>(
        'crm.deal.list',
        {
          filter: { CONTACT_ID: entities.contact, ...filtroEmbudosPropios() },
          select: ['ID'],
          order: { DATE_CREATE: 'DESC' },
        },
        auth,
      );
      const found = Array.isArray(r) ? r[0] : undefined;
      if (found?.ID) dealId = Number(found.ID);
    } catch (e) {
      log.warn('asignarAsesorPorTurno: buscar deal por contacto falló', { err: String(e), contactId: entities.contact });
    }
  }
  if (!dealId) return false;

  const LOCK = `asignacion:tarea:deal#${dealId}`;
  const ASESOR_KEY = `asignacion:asesor:deal#${dealId}`;
  const NO_PILOTO = `asignacion:nopiloto:deal#${dealId}`;

  // Atajos baratos (Redis) para no pedirle el deal a Bitrix en CADA mensaje: si ya se asignó y no
  // venimos a re-verificar por un escalamiento, o si ya se supo que este deal no es del piloto, corta.
  const yaAsignado = (await redis.exists(LOCK).catch(() => 0)) === 1;
  if (yaAsignado && motivo !== 'escalado') return false;
  if (!yaAsignado && (await redis.exists(NO_PILOTO).catch(() => 0)) === 1) return false;

  try {
    const d: any = await callCrm(
      'crm.deal.get',
      { id: dealId, select: [config.ufPrograma, 'TITLE', 'ASSIGNED_BY_ID'] },
      auth,
    );
    const programaTexto = String(d?.[config.ufPrograma] ?? d?.TITLE ?? '');
    const prog = programaTexto
      ? config.marchaBlancaProgramas.find((p) => programaCoincide(programaTexto, p))
      : undefined;
    if (!prog || !prog.asesorNorteId || !prog.asesorSurId) {
      // No es del piloto: recuérdalo un rato para no volver a consultarlo en cada turno.
      await redis.set(NO_PILOTO, '1', 'EX', 24 * 3600).catch(() => {});
      return false;
    }

    // Ya se había asignado y ahora el bot está escalando: verifica que el deal siga con un asesor
    // del programa. Si volvió al responsable POR DEFECTO del embudo (alguien reasignó, o una
    // automatización de Bitrix lo devolvió), lo corrige — pero si lo tiene cualquier otra persona,
    // se respeta esa asignación (decisión del usuario: el bot no le quita un deal a un asesor real).
    if (yaAsignado) {
      const actual = Number(d?.ASSIGNED_BY_ID ?? 0);
      const esDelPrograma = actual === prog.asesorNorteId || actual === prog.asesorSurId;
      if (esDelPrograma || !config.responsablesPorDefecto.includes(actual)) return false;
      const guardado = Number((await redis.get(ASESOR_KEY).catch(() => null)) ?? 0);
      const destino = guardado === prog.asesorNorteId || guardado === prog.asesorSurId ? guardado : prog.asesorNorteId;
      await callCrm('crm.deal.update', { id: dealId, fields: { ASSIGNED_BY_ID: destino } }, auth);
      log.info('asignarAsesorPorTurno: responsable corregido al escalar', {
        dealId,
        programa: prog.key,
        estabaEn: actual,
        vuelveA: destino,
      });
      return true;
    }

    const primeraVez = await once(LOCK, 365 * 24 * 3600);
    if (!primeraVez) return false; // otra réplica lo tomó entremedio

    const turno = await redis.incr(`asignacion:turno:${prog.key}`);
    const asesorId = turno % 2 === 1 ? prog.asesorNorteId : prog.asesorSurId;
    const asesorNombre = turno % 2 === 1 ? prog.asesorNorte : prog.asesorSur;

    await callCrm('crm.deal.update', { id: dealId, fields: { ASSIGNED_BY_ID: asesorId } }, auth);
    // Se recuerda a QUIÉN le tocó: si más adelante hay que corregir el responsable, vuelve al mismo
    // asesor en vez de consumir otro turno y desbalancear el reparto.
    await redis.set(ASESOR_KEY, String(asesorId), 'EX', 365 * 24 * 3600).catch(() => {});

    if (!crearTarea) {
      log.info('asignarAsesorPorTurno: asignado sin tarea', { dealId, programa: prog.key, motivo, turno, asesorId, asesorNombre });
      return true;
    }

    const deadline = new Date(Date.now() + config.asignacionTareaHoras * 3600_000).toISOString();
    const { titulo, descripcion, prioridad } =
      motivo === 'silencio'
        ? {
            titulo: `🕓 Contacto temprano (${prog.nombre}) — Deal #${dealId}`,
            descripcion:
              `El cliente dejó de responder al bot tras el recordatorio automático.\n` +
              `Programa: ${prog.nombre}\nNo es urgente, pero conviene contactarlo pronto (dentro de ${config.asignacionTareaHoras} horas) ` +
              `mientras el interés sigue fresco. El bot sigue disponible si el cliente vuelve a escribir.`,
            prioridad: 1,
          }
        : motivo === 'automatico'
          ? {
              titulo: `📋 Nuevo lead (${prog.nombre}) — Deal #${dealId}`,
              descripcion:
                `El bot está conversando con este cliente sobre ${prog.nombre}.\n` +
                `No hay nada urgente que hacer todavía — el bot sigue respondiendo. Este deal queda asignado a ti ` +
                `para que puedas hacerle seguimiento cuando quieras, en vez de quedar con el responsable por defecto.`,
              prioridad: 1,
            }
          : {
              titulo: `📞 Seguimiento (${prog.nombre}) — Deal #${dealId}`,
              descripcion:
                `El bot escaló esta conversación a un asesor humano.\n` +
                `Programa: ${prog.nombre}\nContactar dentro de ${config.asignacionTareaHoras} horas.`,
              prioridad: 2,
            };
    const t = await callCrm<BitrixTaskAddResult>(
      'tasks.task.add',
      {
        fields: {
          TITLE: titulo,
          DESCRIPTION: descripcion,
          RESPONSIBLE_ID: asesorId,
          DEADLINE: deadline,
          PRIORITY: prioridad,
          UF_CRM_TASK: [`D_${dealId}`],
        },
      },
      auth,
    );
    log.info('asignarAsesorPorTurno: asignado y tarea creada', {
      dealId,
      programa: prog.key,
      motivo,
      turno,
      asesorId,
      asesorNombre,
      taskId: (t as any)?.task?.id ?? (t as any)?.id,
    });
    return true;
  } catch (e) {
    log.warn('asignarAsesorPorTurno falló', { err: String(e), dealId });
    return false;
  }
}

/**
 * Asigna la negociación a UN responsable fijo (config.derivarATodo), ignorando el reparto por turno.
 *
 * Es el modo "un solo punto de entrada": todas las derivaciones caen en la misma persona, que
 * distribuye después. Se usa en Carver, donde además cubre un vacío — sin programas piloto
 * configurados, asignarAsesorPorTurno devuelve false y las derivaciones POR SILENCIO no llegaban a
 * nadie: el barrido las descartaba sin asignar ni auditar.
 *
 * Devuelve true solo si realmente asignó, para que el llamador distinga "se derivó" de "no aplicaba".
 */
export async function derivarAResponsableFijo(entities: CrmEntities, auth: Auth): Promise<boolean> {
  const destino = config.derivarATodo;
  if (!destino) return false;

  let dealId = entities.deal;
  if (!dealId && entities.contact) {
    try {
      const r = await callCrm<Array<{ ID: string }>>(
        'crm.deal.list',
        // Solo negociaciones de los embudos propios: sin el filtro se tomaba la más reciente de
        // CUALQUIER embudo, se descubría que era ajena y la derivación terminaba en nada, en silencio.
        { filter: { CONTACT_ID: entities.contact, ...filtroEmbudosPropios() }, select: ['ID'], order: { DATE_CREATE: 'DESC' } },
        auth,
      );
      const hallado = Array.isArray(r) ? r[0] : undefined;
      if (hallado?.ID) dealId = Number(hallado.ID);
    } catch (e) {
      log.warn('derivarAResponsableFijo: no se pudo buscar el deal del contacto', { err: String(e) });
    }
  }
  if (!dealId) return false;
  // Una negociación de otro embudo no se toca, aunque Bitrix haya enlazado el chat a ella.
  if (!(await esEmbudoPropio(dealId, auth))) {
    log.info('derivarAResponsableFijo: la negociación es de otro embudo; no se reasigna', { dealId });
    return false;
  }

  try {
    const d: any = await callCrm('crm.deal.get', { id: dealId, select: ['ASSIGNED_BY_ID', 'TITLE'] }, auth);
    const actual = Number(d?.ASSIGNED_BY_ID ?? 0);
    const titulo = String(d?.TITLE ?? '');
    if (actual === destino) {
      await crearTareaSeguimiento(dealId, destino, titulo, auth);
      await auditarDerivacion(dealId, 'tarea_al_punto_de_entrada', { asesor: destino });
      return true;
    }

    // Si ya hay un asesor de verdad a cargo, NO se le quita el lead: se le avisa con una tarea.
    // Quitárselo dejaba el embudo entero en manos del punto de entrada —165 negociaciones en una
    // sola persona— y le borraba el trabajo al que venía siguiendo el caso.
    const vigencia = await vigenciaDelAsesor(actual, auth);
    if (vigencia === 'vigente') {
      await crearTareaSeguimiento(dealId, actual, titulo, auth);
      await auditarDerivacion(dealId, 'tarea_al_asesor_vigente', { asesor: actual });
      log.info('derivarAResponsableFijo: la negociación ya tiene asesor; se le creó tarea en vez de reasignar', { dealId, asesor: actual });
      return true;
    }

    // Sin asesor que pueda atenderla (responsable por defecto, robot, alguien dado de baja o de OTRO
    // equipo): ahí sí entra el punto de entrada único, que para eso existe. Solo se toca ESTA
    // negociación, la que el cliente está conversando ahora: nada histórico se reasigna en bloque.
    await callCrm('crm.deal.update', { id: dealId, fields: { ASSIGNED_BY_ID: destino } }, auth);
    await crearTareaSeguimiento(dealId, destino, titulo, auth);
    // Trazabilidad en la propia ficha: quién la tenía y por qué cambió, para poder revertirlo.
    await callCrm(
      'crm.timeline.comment.add',
      {
        fields: {
          ENTITY_ID: dealId,
          ENTITY_TYPE: 'deal',
          COMMENT:
            `🔁 El asistente asignó esta negociación al punto de entrada (usuario ${destino}) al derivarla. ` +
            `Responsable anterior: usuario ${actual || 'ninguno'} (${MOTIVO_TEXTO[vigencia]}).`,
        },
      },
      auth,
    ).catch((e) => log.warn('derivarAResponsableFijo: no se pudo dejar la nota de reasignación', { err: String(e), dealId }));
    await auditarDerivacion(dealId, 'asignada_al_punto_de_entrada', { asesor: destino, antes: actual, motivo: vigencia });
    log.info('derivarAResponsableFijo: negociación sin asesor válido; asignada al punto de entrada', { dealId, destino, antes: actual, motivo: vigencia });
    return true;
  } catch (e) {
    log.warn('derivarAResponsableFijo: no se pudo derivar', { err: String(e), dealId, destino });
    return false;
  }
}

type Vigencia = 'vigente' | 'sin_responsable' | 'automatico' | 'por_defecto' | 'inactivo' | 'otro_equipo';
const MOTIVO_TEXTO: Record<Vigencia, string> = {
  vigente: 'asesor vigente',
  sin_responsable: 'sin responsable',
  automatico: 'era una automatización, no una persona',
  por_defecto: 'era el responsable por defecto del embudo',
  inactivo: 'usuario dado de baja',
  otro_equipo: 'no pertenece al equipo de esta marca',
};

async function auditarDerivacion(dealId: number, decision: string, detail: Record<string, unknown>): Promise<void> {
  await audit({ type: 'derivacion', crmEntity: `deal#${dealId}`, detail: { decision, ...detail } }).catch(() => {});
}

/**
 * ¿El responsable actual es alguien que de verdad puede trabajar el caso?
 *
 * No basta con que el campo tenga un número. El responsable por defecto del embudo y los robots no
 * son asesores, y alguien dado de baja tampoco: dejarle el lead sería mandarlo a un buzón donde
 * nadie mira. Medido al limpiar Carver: 8 de los asesores que figuraban en el historial estaban
 * dados de baja, uno de ellos con 46 negociaciones.
 */
async function vigenciaDelAsesor(userId: number, auth: Auth): Promise<Vigencia> {
  if (!userId) return 'sin_responsable';
  if (config.usuariosAutomaticos.includes(userId)) return 'automatico';
  if (config.responsablesPorDefecto.includes(userId)) return 'por_defecto';
  try {
    const [u] = await getUsuarios([userId], auth);
    if (u?.activo === false) return 'inactivo';
    // Activo pero de otro equipo: el portal es compartido, y una ficha enlazada al chat puede estar a
    // cargo de un ejecutivo de Postgrados o IPG (hallazgo 9). Ese caso no es suyo.
    if (u && !perteneceAlEquipo(u)) return 'otro_equipo';
    return 'vigente';
  } catch {
    // Ante la duda se lo deja a quien lo tiene: equivocarse hacia "no tocar" es reversible.
    return 'vigente';
  }
}

/** Tarea de seguimiento sobre la negociación, para el asesor que corresponda. Una por derivación:
 *  si el cliente escribe tres veces en la tarde, el asesor no recibe tres tareas iguales. */
async function crearTareaSeguimiento(dealId: number, asesorId: number, titulo: string, auth: Auth): Promise<void> {
  if (!(await once(`tarea:derivacion:${dealId}:${asesorId}`, config.asignacionTareaHoras * 3600))) return;
  const deadline = new Date(Date.now() + config.asignacionTareaHoras * 3600_000).toISOString();
  try {
    const t = await callCrm<BitrixTaskAddResult>(
      'tasks.task.add',
      {
        fields: {
          TITLE: `📞 Seguimiento — ${titulo || `Deal #${dealId}`}`,
          DESCRIPTION:
            'El asistente derivó esta conversación: el cliente pidió hablar con una persona o quedó en silencio tras mostrar interés.\n\n' +
            `La negociación sigue siendo tuya. Contáctalo dentro de ${config.asignacionTareaHoras} horas, mientras el interés está fresco.`,
          RESPONSIBLE_ID: asesorId,
          DEADLINE: deadline,
          PRIORITY: 2,
          UF_CRM_TASK: [`D_${dealId}`],
        },
      },
      auth,
    );
    await audit({ type: 'tarea_derivacion', crmEntity: `deal#${dealId}`, detail: { asesorId } });
    log.info('tarea de seguimiento creada', { dealId, asesorId, taskId: (t as any)?.task?.id ?? (t as any)?.id });
  } catch (e) {
    log.warn('no se pudo crear la tarea de seguimiento', { err: String(e), dealId, asesorId });
  }
}
