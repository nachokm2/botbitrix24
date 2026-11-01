import type { Request, Response } from 'express';
import { callBitrix } from '../bitrix/client';
import { getRedisClient } from '../store/kv';
import { getState, type Auth } from '../store';
import { config } from '../config';
import { lineaDelChat } from '../core/listaBlanca';
import { asesoresDisponibles } from '../core/horarioAsesores';
import { getSession, saveSession, leerTraspaso, borrarTraspaso, PREFIJO_TRASPASO } from '../session';
import { setHistory } from './memory';
import { procesarMensajeSintetico } from '../routes/botEvents';
import { audit } from '../obs/audit';
import { log } from '../log';

/**
 * El bot retoma una conversación que una persona tomó y dejó sin responder.
 *
 * Cuando una asesora toma un chat —lo intercepta, o el bot se lo deriva—, Bitrix saca al bot de la
 * sesión y deja de entregarle los mensajes. Hasta ahora eso duraba lo que durara la sesión: un sábado
 * quedaron cuatro clientes esperando a una asesora que volvía el lunes (31-10-2026), dos de ellos a
 * mitad de la ficha de matrícula.
 *
 * Cada 10 minutos se revisan las conversaciones traspasadas. Si la última palabra es del cliente y
 * nadie del equipo escribe hace RETOMAR_CHAT_HORAS, la sesión se le devuelve al bot en Bitrix y el bot
 * responde lo pendiente, con lo que la asesora haya conversado como contexto. Si la asesora sigue
 * escribiendo, el reloj se reinicia: el bot no se mete en una conversación viva.
 */

/** WhatsApp solo deja responder libremente dentro de las 24 h del último mensaje del cliente. */
const VENTANA_WHATSAPP_MS = 23 * 3600_000;
const INTERVALO_MS = 10 * 60_000;
const MAX_POR_BARRIDO = 20;

type Participante = { id?: number | string; bot?: boolean; extranet?: boolean; connector?: boolean };
type Mensaje = { id?: number | string; author_id?: number | string; date?: string; text?: string };

export type EstadoChat = {
  /** Personas del equipo dentro del chat (no el bot, no el cliente). */
  equipo: string[];
  clienteId: string | null;
  /** Lo que el cliente escribió después de la última respuesta de alguien (bot o equipo). */
  pendientes: string[];
  ultimoPendienteId: string | null;
  /** Cuándo escribió por última vez alguien del equipo (ms), o 0. */
  ultimaDelEquipo: number;
  /** Cuándo escribió por última vez el cliente (ms), o 0. */
  ultimaDelCliente: number;
};

/** Lee quién está en el chat y qué quedó sin responder. PURO sobre lo que devuelve Bitrix. */
export function leerEstado(participantes: Participante[], mensajes: Mensaje[], botId: number): EstadoChat {
  const esBot = (u: Participante) => Boolean(u.bot) || String(u.id) === String(botId);
  const cliente = participantes.find((u) => !esBot(u) && (u.connector || u.extranet));
  const clienteId = cliente?.id != null ? String(cliente.id) : null;
  const equipo = participantes.filter((u) => !esBot(u) && !u.connector && !u.extranet && u.id != null).map((u) => String(u.id));

  const ordenados = [...mensajes].sort((a, b) => Number(a.id ?? 0) - Number(b.id ?? 0));
  let ultimaDelEquipo = 0;
  let ultimaDelCliente = 0;
  let pendientes: { id: string; texto: string }[] = [];
  for (const m of ordenados) {
    const autor = String(m.author_id ?? '0');
    if (autor === '0') continue; // mensajes del sistema
    const at = m.date ? new Date(m.date).getTime() : 0;
    if (clienteId && autor === clienteId) {
      ultimaDelCliente = Math.max(ultimaDelCliente, at);
      const texto = String(m.text ?? '').trim();
      if (texto) pendientes.push({ id: String(m.id ?? ''), texto });
    } else {
      // Respondió alguien (el bot o el equipo): lo anterior ya no está pendiente.
      pendientes = [];
      if (autor !== String(botId)) ultimaDelEquipo = Math.max(ultimaDelEquipo, at);
    }
  }
  return {
    equipo,
    clienteId,
    pendientes: pendientes.map((p) => p.texto),
    ultimoPendienteId: pendientes.length ? pendientes[pendientes.length - 1].id : null,
    ultimaDelEquipo,
    ultimaDelCliente,
  };
}

/** ¿Corresponde retomar? Devuelve el motivo para NO hacerlo, o null si hay que retomar. */
export function motivoParaNoRetomar(e: EstadoChat, traspasoAt: number, horas: number, ahora = Date.now()): string | null {
  if (!e.equipo.length) return 'nadie_del_equipo_en_el_chat';
  if (!e.pendientes.length) return 'el_cliente_no_espera_respuesta';
  if (ahora - e.ultimaDelCliente > VENTANA_WHATSAPP_MS) return 'fuera_de_la_ventana_de_24h';
  const ultimaActividad = Math.max(e.ultimaDelEquipo, traspasoAt);
  if (ahora - ultimaActividad < horas * 3600_000) return 'el_equipo_estuvo_activo_hace_poco';
  return null;
}

/** Le devuelve la sesión al bot. Primero como traspaso directo; si Bitrix lo exige, interceptándola antes. */
async function devolverAlBot(chatId: string, botId: number, auth: Auth): Promise<{ ok: boolean; metodo?: string; errores: string[] }> {
  const errores: string[] = [];
  const transferir = () => callBitrix('imopenlines.operator.transfer', { CHAT_ID: chatId, TRANSFER_ID: botId }, auth);
  try {
    await transferir();
    return { ok: true, metodo: 'transfer', errores };
  } catch (e) {
    errores.push(`transfer: ${String(e).slice(0, 160)}`);
  }
  try {
    await callBitrix('imopenlines.session.intercept', { CHAT_ID: chatId }, auth);
    await transferir();
    return { ok: true, metodo: 'intercept+transfer', errores };
  } catch (e) {
    errores.push(`intercept+transfer: ${String(e).slice(0, 160)}`);
  }
  return { ok: false, errores };
}

const participantesDe = async (dialogId: string, auth: Auth) => {
  const r = await callBitrix<Participante[]>('im.dialog.users.list', { DIALOG_ID: dialogId }, auth);
  return Array.isArray(r) ? r : [];
};

export type ResultadoRetoma = {
  dialogId: string;
  retomado: boolean;
  motivo?: string;
  metodo?: string;
  errores?: string[];
  equipoAntes?: string[];
  equipoDespues?: string[];
  botDentro?: boolean;
  respondido?: boolean;
};

/**
 * Evalúa una conversación y, si corresponde (o si `forzar`), se la devuelve al bot y responde lo
 * pendiente. `forzar` salta el reloj de horas, no las demás condiciones: es para probar en un chat
 * concreto desde /setup/retomar-chat.
 */
export async function retomarChat(dialogId: string, opts: { forzar?: boolean; responder?: boolean } = {}): Promise<ResultadoRetoma> {
  const st = await getState();
  const auth = st.installAuth ?? st.auth;
  const botId = Number(st.botId ?? config.botId);
  if (!auth || !botId) return { dialogId, retomado: false, motivo: 'sin_auth_o_bot' };
  const chatId = dialogId.replace(/^chat/, '');

  if (config.openlinesLineasPermitidas.length) {
    const linea = await lineaDelChat(chatId, auth);
    if (!linea || !config.openlinesLineasPermitidas.includes(linea)) return { dialogId, retomado: false, motivo: 'linea_no_permitida' };
  }
  // En horario de asesores el bot devuelve el chat a la cola apenas lo recibe: retomarlo sería un
  // ida y vuelta sin respuesta.
  if (asesoresDisponibles()) return { dialogId, retomado: false, motivo: 'horario_de_asesores' };

  const traspaso = await leerTraspaso(dialogId);
  const [participantes, crudo] = await Promise.all([
    participantesDe(dialogId, auth),
    callBitrix<any>('im.dialog.messages.get', { DIALOG_ID: dialogId, LIMIT: 30 }, auth),
  ]);
  const mensajes: Mensaje[] = Array.isArray(crudo) ? crudo : (crudo?.messages ?? []);
  const estado = leerEstado(participantes, mensajes, botId);
  const motivo = motivoParaNoRetomar(estado, traspaso?.at ?? 0, opts.forzar ? 0 : config.retomarChatHoras);
  if (motivo) return { dialogId, retomado: false, motivo, equipoAntes: estado.equipo };

  const d = await devolverAlBot(chatId, botId, auth);
  const despues = await participantesDe(dialogId, auth).catch(() => [] as Participante[]);
  const equipoDespues = leerEstado(despues, [], botId).equipo;
  const botDentro = despues.some((u) => u.bot || String(u.id) === String(botId));
  if (!d.ok || !botDentro) {
    void audit({ type: 'retoma_fallida', dialogId, detail: { errores: d.errores, botDentro } }).catch(() => {});
    log.warn('retomarChat: Bitrix no le devolvió la sesión al bot', { dialogId, errores: d.errores, botDentro });
    return { dialogId, retomado: false, motivo: 'bitrix_no_devolvio_la_sesion', errores: d.errores, equipoAntes: estado.equipo, equipoDespues, botDentro };
  }

  // La conversación vuelve a ser del bot: se olvida el traspaso y el estado de "humano a cargo". La
  // memoria del bot se vacía a propósito: no vio lo que conversó la asesora, y en el próximo turno lee
  // los últimos 30 mensajes del chat (ver crm/historialChat.ts), así retoma desde ahí sin contradecirla.
  await borrarTraspaso(dialogId);
  const s = await getSession(dialogId);
  delete s.humanTookOver;
  await saveSession(dialogId, s);
  await setHistory(dialogId, []);

  let respondido = false;
  if (opts.responder !== false && estado.pendientes.length && estado.clienteId) {
    const dialogo: any = await callBitrix('im.dialog.get', { DIALOG_ID: dialogId }, auth).catch(() => ({}));
    await procesarMensajeSintetico(
      {
        DIALOG_ID: dialogId,
        CHAT_ID: chatId,
        MESSAGE: estado.pendientes.join('\n'),
        MESSAGE_ID: `retoma-${chatId}-${estado.ultimoPendienteId ?? Date.now()}`,
        FROM_USER_ID: estado.clienteId,
        CHAT_ENTITY_TYPE: 'LINES',
        CHAT_ENTITY_DATA_1: dialogo?.entity_data_1 ?? '',
        CHAT_ENTITY_DATA_2: dialogo?.entity_data_2 ?? '',
      },
      botId,
    );
    respondido = true;
  }
  void audit({ type: 'chat_retomado', dialogId, detail: { metodo: d.metodo, pendientes: estado.pendientes.length, forzado: Boolean(opts.forzar) } }).catch(() => {});
  log.info('retomarChat: el bot retomó la conversación', { dialogId, metodo: d.metodo, pendientes: estado.pendientes.length });
  return { dialogId, retomado: true, metodo: d.metodo, errores: d.errores, equipoAntes: estado.equipo, equipoDespues, botDentro, respondido };
}

/** Recorre las conversaciones traspasadas y retoma las que quedaron sin respuesta. */
export async function barrerChatsTomados(): Promise<void> {
  const r = getRedisClient();
  if (!r || config.retomarChatHoras <= 0) return;
  let cursor = '0';
  let revisados = 0;
  do {
    const [siguiente, claves] = await r.scan(cursor, 'MATCH', `${PREFIJO_TRASPASO}*`, 'COUNT', 200);
    cursor = siguiente;
    for (const clave of claves) {
      if (revisados >= MAX_POR_BARRIDO) return;
      const dialogId = clave.slice(PREFIJO_TRASPASO.length);
      const t = await leerTraspaso(dialogId);
      // Sin el plazo cumplido desde el traspaso no hay nada que mirar todavía: ahorra llamadas.
      if (!t || Date.now() - t.at < config.retomarChatHoras * 3600_000) continue;
      revisados++;
      try {
        const res = await retomarChat(dialogId);
        if (res.retomado || res.motivo === 'bitrix_no_devolvio_la_sesion') log.info('barrido de chats tomados', res);
      } catch (e) {
        log.warn('barrido de chats tomados: falló un chat', { dialogId, err: String(e) });
      }
    }
  } while (cursor !== '0');
}

let timer: ReturnType<typeof setInterval> | null = null;

export function iniciarRetomaDeChats(): void {
  if (timer || config.retomarChatHoras <= 0 || !getRedisClient()) return;
  timer = setInterval(() => void barrerChatsTomados().catch((e) => log.warn('barrerChatsTomados', { err: String(e) })), INTERVALO_MS);
  timer.unref?.();
  log.info('retoma de chats tomados activa', { horas: config.retomarChatHoras, cadaMin: INTERVALO_MS / 60_000 });
}

/** GET /setup/retomar-chat?chat=598649[&responder=0] — prueba en UN chat, sin esperar el plazo. */
export async function retomarChatManual(req: Request, res: Response) {
  const chat = String(req.query.chat ?? '').replace(/\D/g, '');
  if (!chat) return res.status(400).json({ ok: false, error: 'Falta ?chat=<id>' });
  const r = await retomarChat(`chat${chat}`, { forzar: true, responder: req.query.responder !== '0' });
  res.json({ ok: true, ...r });
}
