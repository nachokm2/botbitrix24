import { anthropic, CLASSIFIER } from './client';
import { getHistory, setHistory } from './memory';
import { transcript } from './briefing';
import { getSession, traspasoVigente } from '../session';
import { asesoresDisponibles, proximoFueraDeHorario } from '../core/horarioAsesores';
import { marca } from '../marca';
import { guardarRespuesta } from '../core/guardRespuesta';
import { URLS_OFICIALES_CARVER } from '../core/promptObjeciones';
import { callBitrix } from '../bitrix/client';
import { getRedisClient, getJson, setJson, kvDel } from '../store/kv';
import { getState } from '../store';
import { config } from '../config';
import { recordTokens, inc } from '../obs/metrics';
import { audit } from '../obs/audit';
import { log } from '../log';
import { asignarAsesorPorTurno, derivarAResponsableFijo } from '../crm/asignacionAsesores';
import { derivacionYaGestionada } from '../crm/embudos';
import { vigilarDerivacion, barrerVigilanciaDerivaciones } from '../crm/vigilanciaDerivaciones';
import { primaryEntity, type CrmEntities } from '../crm/entities';

// Seguimiento automático (WhatsApp/Open Lines) en 3 etapas, si el bot respondió y el cliente quedó
// en silencio — las TRES ancladas a la MISMA última respuesta del bot (no una después de la otra):
//  1) A las SEGUIMIENTO_HORAS (ej. 3h): se le manda UN mensaje de seguimiento (generado por IA a
//     partir de la propia conversación) — ver barrerSeguimientosVencidos.
//  2) A las SEGUIMIENTO_TRANSFERENCIA_HORAS (más tarde, ej. 4h): si el cliente SIGUE sin responder
//     (ni siquiera al recordatorio), se deriva el lead al asesor asignado por turno + se crea una
//     tarea — ver barrerTransferenciasVencidas. NO es una transferencia urgente (no se silencia al
//     bot ni se toma la sesión de Open Lines): es solo para que un humano pueda contactarlo temprano
//     por su cuenta; si el cliente vuelve a escribir, el bot le sigue respondiendo normal.
//  3) A las SEGUIMIENTO_SEGUNDO_HORAS (ej. 10h): ÚLTIMO recordatorio por IA, con otro tono (cierra
//     dejando la puerta abierta en vez de volver a preguntar lo mismo) — ver
//     barrerSegundosRecordatoriosVencidos. Va después de la derivación a propósito: el asesor ya
//     tiene el lead, pero el bot le da una última oportunidad de retomar por su cuenta.
// Si el cliente responde en cualquier momento, botEvents.ts vuelve a llamar a programarSeguimiento
// tras la respuesta del bot, lo que reprograma (o cancela, ver más abajo) ambas etapas desde cero.
//
// Se agenda con 3 ZSETs en Redis (dialogId -> vencimiento) que un barrido periódico recorre — mismo
// patrón que store/db.ts:startRetentionSweep. Solo WhatsApp: es el único canal donde el bot puede
// escribirle a alguien por iniciativa propia (Web Chat/Instagram/Messenger no tienen una forma de
// "empujar" un mensaje al visitante fuera de una respuesta), y el único con deals reales a los que
// asignar un asesor por turno.

const DUE_KEY = 'seguimiento:due';
const SEGUNDO_KEY = 'seguimiento:segundo:due';
const TRANSFER_KEY = 'seguimiento:transferencia:due';
const ENTITIES_TTL_SEC = 2 * 24 * 3600; // cubre holgado el plazo de la transferencia (la única etapa que los usa)
const TIMEZONE = 'America/Santiago';

const ENTITIES_KEY = (dialogId: string) => `seguimiento:entidades:${dialogId}`;
// Instantánea de la conversación al programar la secuencia. La memoria del chat (ai/memory.ts) vence
// a las 6 h y el último recordatorio se programa a las 10: sin esta copia lo encontraba vacía y se
// descartaba EN SILENCIO. En el piloto de Carver se enviaron 100+ primeros recordatorios y CERO
// segundos (logs del 10 al 13 de octubre de 2026), aunque el segundo estaba configurado.
const SNAPSHOT_KEY = (dialogId: string) => `seguimiento:snapshot:${dialogId}`;
const SNAPSHOT_TTL_SEC = 2 * 24 * 3600;
// Último recordatorio enviado, para saber si la persona RESPONDIÓ a él (no basta con haberlo enviado).
const ULTIMO_KEY = (dialogId: string) => `seguimiento:ultimo:${dialogId}`;
// Envíos proactivos de las últimas 24 h, para el tope diario.
const ENVIADOS_KEY = (dialogId: string) => `seguimiento:enviados:${dialogId}`;
// WhatsApp solo admite mensajes libres dentro de las 24 h desde el último mensaje del cliente. Se deja
// margen: un recordatorio que sale después no llega, aunque Bitrix lo acepte.
const VENTANA_WHATSAPP_MS = 23.5 * 3600_000;

type Snapshot = { transcript: string; clienteAt: number; sesion: string | null };

const TONO_SEGUIMIENTO = `Escribe en español de Chile, tratando siempre de "usted" (nunca tuteas ni voseas). No inventes datos ni programas, no uses un saludo formal tipo "Estimado/a", y no empieces con "Oye" ni otras muletillas informales similares ("Ey", "Oiga"). NUNCA uses voseo chileno ("cómo estai", "cachai", "teni") ni jerga de calle: representas a una universidad — cercano pero profesional, como corresponde a una asesora. Devuelve SOLO el mensaje, sin comillas ni explicación.`;

// La identidad del recordatorio sale de la marca. Estaba fija en "Sofía, asesora de Postgrados de la
// Universidad Autónoma de Chile" también para Carver: el seguimiento le hablaba al cliente con otra
// identidad y en el mismo chat nombraba al asesor en tercera persona ("coordinar con Ignacio").
const TONO_SEGUIMIENTO_ASESOR = `Escribe en ${marca.espanol}, tratando siempre de "usted". Sin saludo formal tipo "Estimado/a", sin negritas, sin enlaces y sin cifras ni costos. No inventes datos ni programas. Devuelve SOLO el mensaje, sin comillas ni explicación.`;

/** Prompt del recordatorio según la etapa: el primero retoma el hilo, el segundo (y último, horas
 *  más tarde) cierra dejando la puerta abierta — si mandara otra vez "¿te quedaron dudas?" se
 *  leería como insistencia, que es justo lo que molesta a alguien que ya decidió no responder. */
function sistemaSeguimiento(etapa: 1 | 2): string {
  if (marca.sePresentaComoAsesor) {
    const baseAsesor =
      `Eres el asesor a cargo de esta conversación en ${marca.organizacion}; ya te presentaste antes. El cliente no ha ` +
      'respondido desde tu último mensaje. NO vuelvas a presentarte ni digas tu nombre, y NO nombres a otras personas del ' +
      'equipo: el seguimiento lo haces tú, en primera persona.';
    if (etapa === 1) {
      return `${baseAsesor} Escribe UN mensaje de seguimiento breve (1 a 2 frases), cálido y natural: retoma el hilo (el programa o tema del que hablaban) y ofrece seguir ayudando. No repitas algo que ya dijiste. ${TONO_SEGUIMIENTO_ASESOR}`;
    }
    return `${baseAsesor} Ya le escribiste UN recordatorio hace varias horas y tampoco respondió: este es el ÚLTIMO mensaje. Escribe UNA frase que cierre con elegancia: entiende que puede no ser el momento y deja la puerta abierta ("quedo atento cuando quiera retomarlo"). NO insistas, NO repitas el recordatorio anterior y NO presiones con urgencia, cupos ni descuentos. ${TONO_SEGUIMIENTO_ASESOR}`;
  }
  const base = 'Eres Sofía, asesora comercial de Postgrados de la Universidad Autónoma de Chile. El cliente no ha respondido desde tu último mensaje.';
  if (etapa === 1) {
    return `${base} Escribe UN mensaje de seguimiento breve (1 a 3 frases), cálido y natural: retoma el hilo de la conversación (el programa o tema del que hablaban) y ofrece seguir ayudando. No repitas literalmente algo que ya dijiste. ${TONO_SEGUIMIENTO}`;
  }
  return `${base} Ya le escribiste UN recordatorio hace varias horas y tampoco respondió: este es el ÚLTIMO mensaje que le enviarás. Escribe UN mensaje breve (1 a 2 frases) que cierre con elegancia: entiende que puede no ser el momento, deja la puerta abierta para cuando quiera retomar y menciona que un asesor queda disponible. NO insistas, NO vuelvas a preguntar "¿te quedaron dudas?" ni repitas el recordatorio anterior, y NO presiones con urgencia, cupos ni descuentos. ${TONO_SEGUIMIENTO}`;
}

/** Hora local (0-23) de Chile para un instante dado — usa Intl.DateTimeFormat en vez de aritmética
 *  manual de offset para que el cambio de horario de verano/invierno quede resuelto solo. */
export function horaEnChile(fecha: Date): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, hour: 'numeric', hour12: false }).format(fecha));
}

/** Si `fecha` cae dentro del horario permitido (seguimientoHoraInicio-seguimientoHoraFin, hora
 *  Chile), la devuelve tal cual. Si no, avanza hora a hora hasta la próxima hora permitida — evita
 *  mandar el seguimiento proactivo de madrugada (esto NO afecta las respuestas normales del bot a
 *  mensajes del cliente, que son inmediatas a cualquier hora). */
export function proximoHorarioPermitido(fecha: Date): Date {
  let t = fecha;
  // Dos condiciones a la vez: la ventana de seguimiento (no escribir de madrugada) y el horario de
  // asesores (no escribir mientras ellos atienden). Se alternan hasta que se cumplen las dos,
  // porque corregir una puede volver a romper la otra: salir de la jornada a las 18:30 cae dentro
  // de la ventana, pero correr al día siguiente a las 9:00 vuelve a caer en jornada.
  for (let vuelta = 0; vuelta < 10; vuelta++) {
    let movido = false;
    for (let i = 0; i < 24; i++) {
      const h = horaEnChile(t);
      if (h >= config.seguimientoHoraInicio && h < config.seguimientoHoraFin) break;
      t = new Date(t.getTime() + 3600_000);
      movido = true;
    }
    const fuera = proximoFueraDeHorario(t);
    if (fuera.getTime() === t.getTime() && !movido) return t;
    if (fuera.getTime() !== t.getTime()) {
      t = fuera;
      continue;
    }
    if (!asesoresDisponibles(t)) return t;
  }
  return t;
}

/** Programa (o reprograma) las 3 etapas del seguimiento de un diálogo, todas desde AHORA (se llama
 *  tras cada respuesta del bot, así que el plazo siempre corre desde la ÚLTIMA vez que el bot
 *  habló): el recordatorio a SEGUIMIENTO_HORAS, la transferencia al asesor a
 *  SEGUIMIENTO_TRANSFERENCIA_HORAS y el último recordatorio a SEGUIMIENTO_SEGUNDO_HORAS. Si esos
 *  plazos caen fuera del horario permitido, se corren al inicio de la próxima ventana. `entities`
 *  (si se pasa) queda guardado para que la transferencia sepa a qué deal/lead asignar —
 *  normalmente ya lo tiene resuelto quien llama (ver botEvents.ts). No hace nada si la regla está
 *  desactivada, si no hay Redis, o si un humano ya tomó la conversación. */
export async function programarSeguimiento(dialogId: string, entities?: CrmEntities, sesionActual?: string | null): Promise<void> {
  const r = getRedisClient();
  if (!r || config.seguimientoHoras <= 0) return;
  try {
    const sess = await getSession(dialogId);
    if (sess.humanTookOver) return;
    const ahora = Date.now();
    // Se programa justo después de que el bot respondió a un mensaje del cliente: este instante marca
    // también el inicio de la ventana de 24 h de WhatsApp.
    const t = config.seguimientoInstantanea ? transcript(await getHistory(dialogId)) : '';
    if (t.length >= 5) {
      await setJson(SNAPSHOT_KEY(dialogId), { transcript: t, clienteAt: ahora, sesion: sesionActual ?? null } satisfies Snapshot, SNAPSHOT_TTL_SEC);
    }
    inc('seguimiento_programado');
    const vencimientoRecordatorio = proximoHorarioPermitido(new Date(ahora + config.seguimientoHoras * 3600_000));
    await r.zadd(DUE_KEY, vencimientoRecordatorio.getTime(), dialogId);
    if (config.seguimientoTransferenciaHoras > 0) {
      // Se calcula relativo al recordatorio YA resuelto (no de nuevo desde "ahora"): si ambos
      // plazos caen de noche, redondear cada uno por separado a "la próxima ventana" los dejaría
      // EMPATADOS en el mismo horario del día siguiente (el recordatorio y la transferencia
      // disparándose juntos) — esto preserva que la transferencia sea siempre estrictamente
      // posterior al recordatorio, dándole al cliente el tiempo real de responder entre ambos.
      const deltaHoras = Math.max(config.seguimientoTransferenciaHoras - config.seguimientoHoras, 0);
      const vencimientoTransferencia = proximoHorarioPermitido(
        new Date(vencimientoRecordatorio.getTime() + deltaHoras * 3600_000),
      );
      await r.zadd(TRANSFER_KEY, vencimientoTransferencia.getTime(), dialogId);
      if (entities && Object.keys(entities).length) {
        await setJson(ENTITIES_KEY(dialogId), entities, ENTITIES_TTL_SEC);
      }
    } else {
      await r.zrem(TRANSFER_KEY, dialogId).catch(() => {});
    }
    if (config.seguimientoSegundoHoras > 0) {
      // Mismo cuidado que con la transferencia: relativo al recordatorio YA resuelto, para que el
      // último mensaje quede siempre estrictamente después del primero aunque ambos plazos caigan
      // de noche y se corran a la misma ventana del día siguiente.
      const deltaHoras = Math.max(config.seguimientoSegundoHoras - config.seguimientoHoras, 0);
      const vencimientoSegundo = proximoHorarioPermitido(
        new Date(vencimientoRecordatorio.getTime() + deltaHoras * 3600_000),
      );
      await r.zadd(SEGUNDO_KEY, vencimientoSegundo.getTime(), dialogId);
    } else {
      await r.zrem(SEGUNDO_KEY, dialogId).catch(() => {});
    }
  } catch (e) {
    log.warn('programarSeguimiento falló', { err: String(e), dialogId });
  }
}

/** Cancela el seguimiento pendiente de un diálogo (un humano tomó la conversación, o el cliente
 *  respondió — ver botEvents.ts, que reprograma en vez de cancelar en ese caso). Cancela las 3
 *  etapas: no tiene sentido recordarle nada ni transferir si ya hay un humano a cargo. */
export async function cancelarSeguimiento(dialogId: string): Promise<void> {
  const r = getRedisClient();
  if (!r) return;
  try {
    await r.zrem(DUE_KEY, dialogId);
    await r.zrem(SEGUNDO_KEY, dialogId);
    await r.zrem(TRANSFER_KEY, dialogId);
  } catch (e) {
    log.warn('cancelarSeguimiento falló', { err: String(e), dialogId });
  }
}

async function generarMensajeSeguimiento(dialogId: string, etapa: 1 | 2): Promise<string | null> {
  let t = transcript(await getHistory(dialogId));
  if (t.length < 5 && config.seguimientoInstantanea) t = (await getJson<Snapshot>(SNAPSHOT_KEY(dialogId)))?.transcript ?? '';
  if (t.length < 5) return null;
  const resp = await anthropic.messages.create({
    model: CLASSIFIER,
    max_tokens: 200,
    system: sistemaSeguimiento(etapa),
    messages: [{ role: 'user', content: `Conversación:\n${t}\n\nEscribe el mensaje de seguimiento.` }],
  });
  recordTokens((resp as any).usage);
  const texto = (resp.content as any[]).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!texto || !marca.guardRespuesta) return texto || null;
  // Las mismas reglas que una respuesta normal: sin markdown, sin fee, sin enlaces no verificados y
  // sin repetir lo que ya se dijo.
  const previas = t.split('\n').filter((l) => l.startsWith('Bot: ')).map((l) => l.slice(5));
  const g = guardarRespuesta(texto, {
    mensajeCliente: '',
    respuestasPrevias: previas,
    urlsPermitidas: URLS_OFICIALES_CARVER,
    maxCaracteres: Number.MAX_SAFE_INTEGER,
  });
  return g.texto || null;
}

/** Motivo por el que un recordatorio vencido NO debe enviarse, o null si se puede enviar. Cada uno
 *  queda auditado: antes estos casos se descartaban sin dejar rastro y no había forma de saber si la
 *  secuencia se cumplía. */
async function motivoParaNoEnviar(dialogId: string): Promise<string | null> {
  const sess = await getSession(dialogId);
  if (sess.humanTookOver) return 'humano_a_cargo';
  const snap = await getJson<Snapshot>(SNAPSHOT_KEY(dialogId));
  if (await traspasoVigente(dialogId, snap?.sesion ?? null)) return 'traspaso_a_persona';
  if (snap && Date.now() - snap.clienteAt > VENTANA_WHATSAPP_MS) return 'fuera_ventana_24h';
  if (config.seguimientoMaxPorDia > 0) {
    const enviados = ((await getJson<number[]>(ENVIADOS_KEY(dialogId))) ?? []).filter((x) => Date.now() - x < 24 * 3600_000);
    if (enviados.length >= config.seguimientoMaxPorDia) return 'tope_diario';
  }
  return null;
}

async function registrarEnvio(dialogId: string, etapa: 1 | 2): Promise<void> {
  const enviados = ((await getJson<number[]>(ENVIADOS_KEY(dialogId))) ?? []).filter((x) => Date.now() - x < 24 * 3600_000);
  await setJson(ENVIADOS_KEY(dialogId), [...enviados, Date.now()], 24 * 3600);
  await setJson(ULTIMO_KEY(dialogId), { etapa, at: Date.now() }, 3 * 24 * 3600);
}

/** El cliente escribió: si lo último que recibió fue un recordatorio, ese recordatorio fue RESPONDIDO.
 *  Separa "enviado" de "contacto efectivo", que es lo que importa medir. */
export async function registrarRespuestaASeguimiento(dialogId: string): Promise<void> {
  try {
    const u = await getJson<{ etapa: number; at: number }>(ULTIMO_KEY(dialogId));
    if (!u) return;
    await kvDel(ULTIMO_KEY(dialogId));
    inc('seguimiento_respondido');
    await audit({
      type: 'seguimiento_respondido',
      dialogId,
      detail: { etapa: u.etapa, horasDesdeEnvio: Math.round(((Date.now() - u.at) / 3600_000) * 10) / 10 },
    });
  } catch (e) {
    log.warn('registrarRespuestaASeguimiento falló', { err: String(e), dialogId });
  }
}

/** Recorre los diálogos vencidos de una cola de recordatorios y envía el mensaje (una sola vez cada
 *  uno — ZREM es el reclamo atómico: si hay más de una réplica corriendo el barrido, solo una logra
 *  "borrar y procesar"). `etapa` decide el tono del mensaje (ver sistemaSeguimiento) y queda en la
 *  auditoría, para poder separar después cuántos respondieron al primero y cuántos al último. */
async function barrerRecordatorios(key: string, etapa: 1 | 2): Promise<void> {
  const r = getRedisClient();
  if (!r) return;
  let vencidos: string[] = [];
  try {
    vencidos = await r.zrangebyscore(key, '-inf', Date.now());
  } catch (e) {
    log.warn('barrerRecordatorios: zrangebyscore falló', { err: String(e), key });
    return;
  }
  if (!vencidos.length) return;

  const st = await getState();
  const auth = st.auth;
  const botId = st.botId ?? config.botId;
  if (!auth || !botId) return; // sin auth/bot no se puede enviar nada todavía

  for (const dialogId of vencidos) {
    const reclamado = await r.zrem(key, dialogId).catch(() => 0);
    if (!reclamado) continue; // otra réplica ya lo tomó

    try {
      // Chequeo defensivo: el plazo se calcula ya respetando el horario (ver programarSeguimiento),
      // pero si el barrido se atrasó (ej. el servicio estuvo caído) puede llegar aquí fuera de
      // ventana — se reprograma en vez de mandar el mensaje fuera de horario.
      const ahora = new Date();
      if (horaEnChile(ahora) < config.seguimientoHoraInicio || horaEnChile(ahora) >= config.seguimientoHoraFin) {
        const vencimiento = proximoHorarioPermitido(ahora);
        await r.zadd(key, vencimiento.getTime(), dialogId);
        continue;
      }

      const motivo = await motivoParaNoEnviar(dialogId);
      if (motivo) {
        inc(`seguimiento_omitido:${motivo}`);
        await audit({ type: 'seguimiento_omitido', dialogId, detail: { etapa, motivo } });
        continue;
      }

      inc('seguimiento_ejecutado');
      const mensaje = await generarMensajeSeguimiento(dialogId, etapa);
      if (!mensaje) {
        inc('seguimiento_omitido:sin_conversacion');
        await audit({ type: 'seguimiento_omitido', dialogId, detail: { etapa, motivo: 'sin_conversacion' } });
        continue;
      }

      // "Enviado" acá significa ENTREGADO A BITRIX (imbot.message.add aceptó el mensaje). La entrega
      // en el teléfono la confirma el conector de WhatsApp y no vuelve por esta vía.
      await callBitrix('imbot.message.add', { BOT_ID: botId, DIALOG_ID: dialogId, MESSAGE: mensaje }, auth);
      await registrarEnvio(dialogId, etapa);
      const history = await getHistory(dialogId);
      await setHistory(dialogId, [...history, { role: 'assistant', content: mensaje }]);
      inc('seguimiento');
      await audit({ type: 'seguimiento', dialogId, detail: { mensaje, etapa } });
      log.info('seguimiento enviado', { dialogId, etapa });
    } catch (e) {
      // Un recordatorio que no se envía es un cliente al que el bot cree haber contactado y no lo
      // hizo. Antes solo quedaba este log y nada en el panel: la auditoría de 'seguimiento' se
      // escribe DESPUÉS del envío, así que los fallos no dejaban ninguna fila (mismo punto ciego que
      // dejó a 3 clientes sin respuesta, ver fix 748885f).
      inc('errors');
      await audit({
        type: 'error',
        dialogId,
        detail: { etapa: etapa === 2 ? 'recordatorio_2' : 'recordatorio_1', err: String(e) },
      }).catch(() => {});
      log.warn('barrerRecordatorios: falló para un diálogo', { err: String(e), dialogId, key });
    }
  }
}

/** Primer recordatorio (SEGUIMIENTO_HORAS): retoma el hilo de la conversación. */
export async function barrerSeguimientosVencidos(): Promise<void> {
  await barrerRecordatorios(DUE_KEY, 1);
}

/** Último recordatorio (SEGUIMIENTO_SEGUNDO_HORAS): cierra dejando la puerta abierta. */
export async function barrerSegundosRecordatoriosVencidos(): Promise<void> {
  if (config.seguimientoSegundoHoras <= 0) return;
  await barrerRecordatorios(SEGUNDO_KEY, 2);
}

/** Recorre los diálogos cuyo plazo de TRANSFERENCIA venció (el cliente no respondió ni al
 *  recordatorio) y deriva el lead al asesor asignado por turno (Norte/Sur) + crea una tarea de
 *  contacto temprano — ver crm/asignacionAsesores.ts. A propósito NO llama a markHumanTakeover ni a
 *  imopenlines.bot.session.operator: no es una transferencia urgente, el bot sigue respondiendo si
 *  el cliente vuelve a escribir (mismo reclamo atómico por ZREM que barrerSeguimientosVencidos). */
export async function barrerTransferenciasVencidas(): Promise<void> {
  const r = getRedisClient();
  if (!r) return;
  let vencidos: string[] = [];
  try {
    vencidos = await r.zrangebyscore(TRANSFER_KEY, '-inf', Date.now());
  } catch (e) {
    log.warn('barrerTransferenciasVencidas: zrangebyscore falló', { err: String(e) });
    return;
  }
  if (!vencidos.length) return;

  const st = await getState();
  const auth = st.auth;
  if (!auth) return; // sin auth no se puede leer/escribir el deal todavía

  for (const dialogId of vencidos) {
    const reclamado = await r.zrem(TRANSFER_KEY, dialogId).catch(() => 0);
    if (!reclamado) continue; // otra réplica ya lo tomó

    try {
      const sess = await getSession(dialogId);
      if (sess.humanTookOver) continue; // ya hay un humano a cargo por otra vía

      const entities = await getJson<CrmEntities>(ENTITIES_KEY(dialogId));
      if (!entities || !(entities.deal || entities.lead || entities.contact)) continue;

      // El asesor pudo tomar el caso en el CRM mientras esta transferencia esperaba su turno: mueve
      // la etapa, llama, manda un correo. Nada de eso pasa por el chat, así que `humanTookOver`
      // sigue en false y antes se derivaba igual, devolviendo la negociación a "Derivados Bot" sin
      // que el cliente hubiera escrito una palabra.
      if (entities.deal && (await derivacionYaGestionada(entities.deal, auth))) {
        log.info('seguimiento: un asesor ya trabajó esta derivación; no se vuelve a derivar', { dialogId, deal: entities.deal });
        continue;
      }

      // Solo cuenta como "derivado" si REALMENTE asignó (deal real de uno de los 2 programas piloto,
      // no asignado antes) — antes se registraba igual aunque no aplicara (ej. sin deal todavía, o
      // programa fuera del piloto), inflando el conteo sin que pasara nada. Además, antes el audit
      // no dejaba `crmEntity` (top-level, la columna que cruza con el panel), quedaba siempre NULL.
      // Con punto de entrada único, la derivación por silencio también va ahí. Sin esto, en una
      // marca sin programas piloto configurados asignarAsesorPorTurno devolvía false y el caso se
      // descartaba: nadie recibía al cliente que había quedado en silencio.
      const asignado =
        (await derivarAResponsableFijo(entities, auth)) || (await asignarAsesorPorTurno(entities, auth, 'silencio'));
      if (!asignado) continue;
      inc('seguimiento_transferencia');
      const entity = primaryEntity(entities);
      await audit({
        type: 'seguimiento_transferencia',
        dialogId,
        crmEntity: entity ? `${entity.type}#${entity.id}` : undefined,
        detail: { entities },
      });
      if (entities.deal) void vigilarDerivacion(entities.deal, dialogId);
      log.info('seguimiento: derivado al asesor por falta de respuesta', { dialogId, entities });
    } catch (e) {
      // Si falla, el lead queda sin asesor asignado y sin tarea, y nadie se entera: el ZREM de más
      // arriba ya lo sacó de la cola, así que no se reintenta nunca.
      inc('errors');
      await audit({ type: 'error', dialogId, detail: { etapa: 'derivacion_por_silencio', err: String(e) } }).catch(() => {});
      log.warn('barrerTransferenciasVencidas: falló para un diálogo', { err: String(e), dialogId });
    }
  }
}

let intervalo: ReturnType<typeof setInterval> | null = null;

/** Arranca el barrido periódico (cada SEGUIMIENTO_INTERVALO_MIN minutos): los 2 recordatorios y la
 *  transferencia corren en el mismo tick. No-op sin Redis o con la regla desactivada
 *  (SEGUIMIENTO_HORAS=0), y no se vuelve a arrancar si ya está corriendo. */
export function iniciarBarridoSeguimientos(): void {
  // La vigilancia de derivaciones vive en el mismo tick, pero es independiente del seguimiento al
  // cliente: una marca puede querer avisarle al asesor sin perseguir al cliente.
  if (!getRedisClient() || intervalo) return;
  if (config.seguimientoHoras <= 0 && config.derivacionAlertaHoras <= 0) return;
  intervalo = setInterval(() => {
    barrerSeguimientosVencidos().catch((e) => log.warn('barrerSeguimientosVencidos (intervalo) falló', { err: String(e) }));
    barrerSegundosRecordatoriosVencidos().catch((e) => log.warn('barrerSegundosRecordatoriosVencidos (intervalo) falló', { err: String(e) }));
    barrerTransferenciasVencidas().catch((e) => log.warn('barrerTransferenciasVencidas (intervalo) falló', { err: String(e) }));
    barrerVigilanciaDerivaciones().catch((e) => log.warn('barrerVigilanciaDerivaciones (intervalo) falló', { err: String(e) }));
  }, config.seguimientoIntervaloMin * 60_000);
  intervalo.unref();
  log.info('seguimiento: barrido activo', {
    horas: config.seguimientoHoras,
    segundoHoras: config.seguimientoSegundoHoras,
    transferenciaHoras: config.seguimientoTransferenciaHoras,
    intervaloMin: config.seguimientoIntervaloMin,
    derivacionAlertaHoras: config.derivacionAlertaHoras,
  });
}
