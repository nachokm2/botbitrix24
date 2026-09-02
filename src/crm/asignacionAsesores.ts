import { callCrm } from '../bitrix/client';
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

function programaCoincide(texto: string, prog: MarchaBlancaPrograma): boolean {
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
): Promise<boolean> {
  if (!config.ufPrograma) return false;
  const redis = getRedisClient();
  if (!redis) return false;

  // Si el chat solo está vinculado a un Contacto (sin Deal) — pasa cuando el auto-CRM nativo de Open
  // Lines todavía no actualizó el vínculo del chat, o el cliente escaló muy rápido, antes de que el
  // bot llegara a resolver el Deal — busca directo en Bitrix si YA existe un Deal para ese contacto
  // (puede existir aunque el chat no lo sepa todavía). Sin esto, ese cliente se queda sin asesor
  // asignado para siempre (caso real: contacto #2398581, Terapia Familiar).
  let dealId = entities.deal;
  if (!dealId && entities.contact) {
    try {
      const r = await callCrm<Array<{ ID: string }>>(
        'crm.deal.list',
        { filter: { CONTACT_ID: entities.contact }, select: ['ID'], order: { DATE_CREATE: 'DESC' } },
        auth,
      );
      const found = Array.isArray(r) ? r[0] : undefined;
      if (found?.ID) dealId = Number(found.ID);
    } catch (e) {
      log.warn('asignarAsesorPorTurno: buscar deal por contacto falló', { err: String(e), contactId: entities.contact });
    }
  }
  if (!dealId) return false;

  try {
    const d: any = await callCrm('crm.deal.get', { id: dealId, select: [config.ufPrograma, 'TITLE'] }, auth);
    const programaTexto = String(d?.[config.ufPrograma] ?? d?.TITLE ?? '');
    if (!programaTexto) return false;

    const prog = config.marchaBlancaProgramas.find((p) => programaCoincide(programaTexto, p));
    if (!prog || !prog.asesorNorteId || !prog.asesorSurId) return false;

    const primeraVez = await once(`asignacion:tarea:deal#${dealId}`, 365 * 24 * 3600);
    if (!primeraVez) return false; // ya se asignó por turno antes; no reasigna ni duplica la tarea

    const turno = await redis.incr(`asignacion:turno:${prog.key}`);
    const asesorId = turno % 2 === 1 ? prog.asesorNorteId : prog.asesorSurId;
    const asesorNombre = turno % 2 === 1 ? prog.asesorNorte : prog.asesorSur;

    await callCrm('crm.deal.update', { id: dealId, fields: { ASSIGNED_BY_ID: asesorId } }, auth);

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
