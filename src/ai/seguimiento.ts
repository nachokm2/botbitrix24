import { anthropic, CLASSIFIER } from './client';
import { getHistory, setHistory } from './memory';
import { transcript } from './briefing';
import { getSession } from '../session';
import { callBitrix } from '../bitrix/client';
import { getRedisClient, getJson, setJson } from '../store/kv';
import { getState } from '../store';
import { config } from '../config';
import { recordTokens, inc } from '../obs/metrics';
import { audit } from '../obs/audit';
import { log } from '../log';
import { asignarAsesorPorTurno } from '../crm/asignacionAsesores';
import type { CrmEntities } from '../crm/entities';

// Seguimiento automático (WhatsApp/Open Lines) en 2 etapas, si el bot respondió y el cliente quedó
// en silencio — ambas ancladas a la MISMA última respuesta del bot (no una después de la otra):
//  1) A las SEGUIMIENTO_HORAS: se le manda UN mensaje de seguimiento (generado por IA a partir de
//     la propia conversación) — ver barrerSeguimientosVencidos.
//  2) A las SEGUIMIENTO_TRANSFERENCIA_HORAS (más tarde, ej. 4h): si el cliente SIGUE sin responder
//     (ni siquiera al recordatorio), se deriva el lead al asesor asignado por turno + se crea una
//     tarea — ver barrerTransferenciasVencidas. NO es una transferencia urgente (no se silencia al
//     bot ni se toma la sesión de Open Lines): es solo para que un humano pueda contactarlo temprano
//     por su cuenta; si el cliente vuelve a escribir, el bot le sigue respondiendo normal.
// Si el cliente responde en cualquier momento, botEvents.ts vuelve a llamar a programarSeguimiento
// tras la respuesta del bot, lo que reprograma (o cancela, ver más abajo) ambas etapas desde cero.
//
// Se agenda con 2 ZSETs en Redis (dialogId -> vencimiento) que un barrido periódico recorre — mismo
// patrón que store/db.ts:startRetentionSweep. Solo WhatsApp: es el único canal donde el bot puede
// escribirle a alguien por iniciativa propia (Web Chat/Instagram/Messenger no tienen una forma de
// "empujar" un mensaje al visitante fuera de una respuesta), y el único con deals reales a los que
// asignar un asesor por turno.

const DUE_KEY = 'seguimiento:due';
const TRANSFER_KEY = 'seguimiento:transferencia:due';
const ENTITIES_TTL_SEC = 2 * 24 * 3600; // cubre holgado el plazo más largo (transferencia)
const TIMEZONE = 'America/Santiago';

const ENTITIES_KEY = (dialogId: string) => `seguimiento:entidades:${dialogId}`;

const SEGUIMIENTO_SYSTEM = `Eres Sofía, asesora comercial de Postgrados de la Universidad Autónoma de Chile. El cliente no ha respondido desde tu último mensaje. Escribe UN mensaje de seguimiento breve (1 a 3 frases), cálido y natural, en español de Chile: retoma el hilo de la conversación (el programa o tema del que hablaban) y ofrece seguir ayudando. No repitas literalmente algo que ya dijiste, no inventes datos ni programas, no uses un saludo formal tipo "Estimado/a". NO empieces el mensaje con "Oye" ni otras muletillas informales similares ("Ey", "Oiga") — cercano pero profesional, como corresponde a una asesora. Devuelve SOLO el mensaje, sin comillas ni explicación.`;

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
  for (let i = 0; i < 24; i++) {
    const h = horaEnChile(t);
    if (h >= config.seguimientoHoraInicio && h < config.seguimientoHoraFin) return t;
    t = new Date(t.getTime() + 3600_000);
  }
  return t;
}

/** Programa (o reprograma) las 2 etapas del seguimiento de un diálogo, ambas desde AHORA (se llama
 *  tras cada respuesta del bot, así que el plazo siempre corre desde la ÚLTIMA vez que el bot
 *  habló): el recordatorio a SEGUIMIENTO_HORAS y, si sigue sin responder, la transferencia al
 *  asesor a SEGUIMIENTO_TRANSFERENCIA_HORAS. Si esos plazos caen fuera del horario permitido, se
 *  corren al inicio de la próxima ventana. `entities` (si se pasa) queda guardado para que la
 *  transferencia sepa a qué deal/lead asignar — normalmente ya lo tiene resuelto quien llama (ver
 *  botEvents.ts). No hace nada si la regla está desactivada, si no hay Redis, o si un humano ya
 *  tomó la conversación. */
export async function programarSeguimiento(dialogId: string, entities?: CrmEntities): Promise<void> {
  const r = getRedisClient();
  if (!r || config.seguimientoHoras <= 0) return;
  try {
    const sess = await getSession(dialogId);
    if (sess.humanTookOver) return;
    const ahora = Date.now();
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
  } catch (e) {
    log.warn('programarSeguimiento falló', { err: String(e), dialogId });
  }
}

/** Cancela el seguimiento pendiente de un diálogo (un humano tomó la conversación, o el cliente
 *  respondió — ver botEvents.ts, que reprograma en vez de cancelar en ese caso). Cancela ambas
 *  etapas: no tiene sentido mandar el recordatorio ni transferir si ya hay un humano a cargo. */
export async function cancelarSeguimiento(dialogId: string): Promise<void> {
  const r = getRedisClient();
  if (!r) return;
  try {
    await r.zrem(DUE_KEY, dialogId);
    await r.zrem(TRANSFER_KEY, dialogId);
  } catch (e) {
    log.warn('cancelarSeguimiento falló', { err: String(e), dialogId });
  }
}

async function generarMensajeSeguimiento(dialogId: string): Promise<string | null> {
  const t = transcript(await getHistory(dialogId));
  if (t.length < 5) return null;
  const resp = await anthropic.messages.create({
    model: CLASSIFIER,
    max_tokens: 200,
    system: SEGUIMIENTO_SYSTEM,
    messages: [{ role: 'user', content: `Conversación:\n${t}\n\nEscribe el mensaje de seguimiento.` }],
  });
  recordTokens((resp as any).usage);
  const texto = (resp.content as any[]).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return texto || null;
}

/** Recorre los diálogos vencidos y envía el seguimiento (una sola vez cada uno — ZREM es el reclamo
 *  atómico: si hay más de una réplica corriendo el barrido, solo una logra "borrar y procesar"). */
export async function barrerSeguimientosVencidos(): Promise<void> {
  const r = getRedisClient();
  if (!r) return;
  let vencidos: string[] = [];
  try {
    vencidos = await r.zrangebyscore(DUE_KEY, '-inf', Date.now());
  } catch (e) {
    log.warn('barrerSeguimientosVencidos: zrangebyscore falló', { err: String(e) });
    return;
  }
  if (!vencidos.length) return;

  const st = await getState();
  const auth = st.auth;
  const botId = st.botId ?? config.botId;
  if (!auth || !botId) return; // sin auth/bot no se puede enviar nada todavía

  for (const dialogId of vencidos) {
    const reclamado = await r.zrem(DUE_KEY, dialogId).catch(() => 0);
    if (!reclamado) continue; // otra réplica ya lo tomó

    try {
      // Chequeo defensivo: el plazo se calcula ya respetando el horario (ver programarSeguimiento),
      // pero si el barrido se atrasó (ej. el servicio estuvo caído) puede llegar aquí fuera de
      // ventana — se reprograma en vez de mandar el mensaje fuera de horario.
      const ahora = new Date();
      if (horaEnChile(ahora) < config.seguimientoHoraInicio || horaEnChile(ahora) >= config.seguimientoHoraFin) {
        const vencimiento = proximoHorarioPermitido(ahora);
        await r.zadd(DUE_KEY, vencimiento.getTime(), dialogId);
        continue;
      }

      const sess = await getSession(dialogId);
      if (sess.humanTookOver) continue; // un humano ya tomó la conversación mientras tanto

      const mensaje = await generarMensajeSeguimiento(dialogId);
      if (!mensaje) continue;

      await callBitrix('imbot.message.add', { BOT_ID: botId, DIALOG_ID: dialogId, MESSAGE: mensaje }, auth);
      const history = await getHistory(dialogId);
      await setHistory(dialogId, [...history, { role: 'assistant', content: mensaje }]);
      inc('seguimiento');
      await audit({ type: 'seguimiento', dialogId, detail: { mensaje } });
      log.info('seguimiento enviado', { dialogId });
    } catch (e) {
      log.warn('barrerSeguimientosVencidos: falló para un diálogo', { err: String(e), dialogId });
    }
  }
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

      await asignarAsesorPorTurno(entities, auth, 'silencio');
      inc('seguimiento_transferencia');
      await audit({ type: 'seguimiento_transferencia', dialogId, detail: { entities } });
      log.info('seguimiento: derivado al asesor por falta de respuesta', { dialogId, entities });
    } catch (e) {
      log.warn('barrerTransferenciasVencidas: falló para un diálogo', { err: String(e), dialogId });
    }
  }
}

let intervalo: ReturnType<typeof setInterval> | null = null;

/** Arranca el barrido periódico (cada SEGUIMIENTO_INTERVALO_MIN minutos): recordatorio y
 *  transferencia corren en el mismo tick. No-op sin Redis o con la regla desactivada
 *  (SEGUIMIENTO_HORAS=0), y no se vuelve a arrancar si ya está corriendo. */
export function iniciarBarridoSeguimientos(): void {
  if (!getRedisClient() || config.seguimientoHoras <= 0 || intervalo) return;
  intervalo = setInterval(() => {
    barrerSeguimientosVencidos().catch((e) => log.warn('barrerSeguimientosVencidos (intervalo) falló', { err: String(e) }));
    barrerTransferenciasVencidas().catch((e) => log.warn('barrerTransferenciasVencidas (intervalo) falló', { err: String(e) }));
  }, config.seguimientoIntervaloMin * 60_000);
  intervalo.unref();
  log.info('seguimiento: barrido activo', {
    horas: config.seguimientoHoras,
    transferenciaHoras: config.seguimientoTransferenciaHoras,
    intervaloMin: config.seguimientoIntervaloMin,
  });
}
