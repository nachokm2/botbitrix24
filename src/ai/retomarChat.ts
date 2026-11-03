import type { Request, Response } from 'express';
import { callBitrix } from '../bitrix/client';
import { getRedisClient } from '../store/kv';
import { getState, type Auth } from '../store';
import { config } from '../config';
import { lineaDelChat } from '../core/listaBlanca';
import { asesoresDisponibles } from '../core/horarioAsesores';
import { getSession, saveSession, leerTraspaso, borrarTraspaso, PREFIJO_TRASPASO, type Traspaso } from '../session';
import { setHistory } from './memory';
import { programarSeguimiento, entidadesDelSeguimiento } from './seguimiento';
import { derivacionYaGestionada } from '../crm/embudos';
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
 *
 * A veces la persona ya no está en el chat y el bot sí: Bitrix le sigue entregando los mensajes y el
 * bot calla solo por la marca de traspaso, que dura 30 días (chat 598649: tres mensajes sin respuesta,
 * con la asesora fuera del chat desde el 14-10). Ahí basta con levantar la marca.
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
  /** El bot sigue en el chat: Bitrix le entrega los mensajes aunque calle. */
  botDentro: boolean;
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
  let pendientes: { id: string; texto: string; at: number }[] = [];
  for (const m of ordenados) {
    const autor = String(m.author_id ?? '0');
    if (autor === '0') continue; // mensajes del sistema
    const at = m.date ? new Date(m.date).getTime() : 0;
    if (clienteId && autor === clienteId) {
      ultimaDelCliente = Math.max(ultimaDelCliente, at);
      // Lo que quedó colgado de una conversación anterior ya no se contesta: si el cliente vuelve
      // días después, se responde solo lo nuevo (el historial del chat da el contexto).
      if (pendientes.length && at - pendientes[pendientes.length - 1].at > VENTANA_WHATSAPP_MS) pendientes = [];
      const texto = String(m.text ?? '').trim();
      if (texto) pendientes.push({ id: String(m.id ?? ''), texto, at });
    } else {
      // Respondió alguien (el bot o el equipo): lo anterior ya no está pendiente.
      pendientes = [];
      if (autor !== String(botId)) ultimaDelEquipo = Math.max(ultimaDelEquipo, at);
    }
  }
  return {
    equipo,
    botDentro: participantes.some(esBot),
    clienteId,
    pendientes: pendientes.map((p) => p.texto),
    ultimoPendienteId: pendientes.length ? pendientes[pendientes.length - 1].id : null,
    ultimaDelEquipo,
    ultimaDelCliente,
  };
}

/** ¿Corresponde retomar? Devuelve el motivo para NO hacerlo, o null si hay que retomar. */
export function motivoParaNoRetomar(e: EstadoChat, traspasoAt: number, horas: number, ahora = Date.now()): string | null {
  if (!e.equipo.length && !e.botDentro) return 'ni_el_bot_ni_el_equipo_en_el_chat';
  if (!e.pendientes.length) return 'el_cliente_no_espera_respuesta';
  if (ahora - e.ultimaDelCliente > VENTANA_WHATSAPP_MS) return 'fuera_de_la_ventana_de_24h';
  const ultimaActividad = Math.max(e.ultimaDelEquipo, traspasoAt);
  if (ahora - ultimaActividad < horas * 3600_000) return 'el_equipo_estuvo_activo_hace_poco';
  return null;
}

// Solo lo que derivó el bot. Si un asesor entró al chat ('operador') o era horario de asesores, el
// chat es de ellos aunque lleven horas sin escribir.
const DERIVACIONES_DEL_BOT = new Set(['escalado', 'auto_escalado']);

/**
 * La otra mitad: una derivación que NADIE tomó y en la que el cliente tampoco espera respuesta (lo
 * último lo dijo el bot). Al derivar se apagan los recordatorios; si después nadie le escribe, el
 * lead queda solo. Carver, 25-10 al 03-11-2026: 8 leads con puntaje alto pasaron 24 h así.
 * Devuelve el motivo para NO devolverle el chat al bot con los recordatorios, o null.
 */
export function motivoParaNoReactivar(e: EstadoChat, t: { at: number; motivo: string }, horas: number, ahora = Date.now()): string | null {
  if (horas <= 0) return 'apagado';
  if (!DERIVACIONES_DEL_BOT.has(t.motivo)) return 'no_fue_una_derivacion_del_bot';
  if (!e.equipo.length && !e.botDentro) return 'ni_el_bot_ni_el_equipo_en_el_chat';
  if (e.pendientes.length) return 'el_cliente_espera_respuesta'; // eso es retomar, no reactivar
  if (e.ultimaDelEquipo >= t.at) return 'el_equipo_escribio_despues_de_derivar';
  if (ahora - t.at < horas * 3600_000) return 'derivacion_reciente';
  if (!e.ultimaDelCliente || ahora - e.ultimaDelCliente > VENTANA_WHATSAPP_MS) return 'fuera_de_la_ventana_de_24h';
  return null;
}

/** La conversación del chat en el formato de la memoria del bot ("Cliente: …" / "Bot: …"), para
 *  escribir los recordatorios cuando esa memoria ya venció. Lo del equipo cuenta como "Bot": el bot
 *  habla como el asesor a cargo. */
export function transcriptDelChat(mensajes: Mensaje[], clienteId: string | null): string {
  return [...mensajes]
    .sort((a, b) => Number(a.id ?? 0) - Number(b.id ?? 0))
    .filter((m) => String(m.author_id ?? '0') !== '0' && String(m.text ?? '').trim())
    .map((m) => `${clienteId && String(m.author_id) === clienteId ? 'Cliente' : 'Bot'}: ${String(m.text).replace(/\s+/g, ' ').trim()}`)
    .join('\n');
}

/**
 * Le devuelve la sesión al bot con un traspaso directo. Si Bitrix lo rechaza, el chat se queda como
 * estaba. Antes se probaba además interceptando la sesión, pero interceptar la deja a nombre del
 * dueño del token (quien instaló la app, no la asesora): si el traspaso posterior fallaba, el chat
 * quedaba asignado a esa persona, como si se lo hubiera tomado ella.
 */
export async function devolverAlBot(chatId: string, botId: number, auth: Auth): Promise<{ ok: boolean; metodo?: string; errores: string[] }> {
  try {
    await callBitrix('imopenlines.operator.transfer', { CHAT_ID: chatId, TRANSFER_ID: botId }, auth);
    return { ok: true, metodo: 'transfer', errores: [] };
  } catch (e) {
    return { ok: false, errores: [`transfer: ${String(e).slice(0, 160)}`] };
  }
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
  /** Mensajes del cliente sin respuesta (cuántos, no cuáles). */
  pendientes?: number;
  /** Solo en simulación: si lo habría retomado. */
  retomaria?: boolean;
};

/**
 * Evalúa una conversación y, si corresponde (o si `forzar`), se la devuelve al bot y responde lo
 * pendiente. `forzar` salta el reloj de horas, no las demás condiciones: es para probar en un chat
 * concreto desde /setup/retomar-chat. `simular` evalúa sin tocar nada; `horas` reemplaza el plazo
 * configurado (para simular antes de encender el barrido).
 */
export async function retomarChat(
  dialogId: string,
  opts: { forzar?: boolean; responder?: boolean; simular?: boolean; horas?: number } = {},
): Promise<ResultadoRetoma> {
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
  const horas = opts.forzar ? 0 : (opts.horas ?? config.retomarChatHoras);
  const motivo = motivoParaNoRetomar(estado, traspaso?.at ?? 0, horas);
  const visto = { dialogId, equipoAntes: estado.equipo, botDentro: estado.botDentro, pendientes: estado.pendientes.length };
  // Nadie espera respuesta, pero puede ser una derivación que nadie tomó: entonces se reactivan los
  // recordatorios en vez de dejar al lead solo.
  const reactivar =
    motivo === 'el_cliente_no_espera_respuesta' && !opts.forzar && traspaso !== null &&
    motivoParaNoReactivar(estado, traspaso, config.reactivarSinTomarHoras) === null;
  if (opts.simular) {
    return { ...visto, retomado: false, retomaria: !motivo || reactivar, motivo: reactivar ? 'reactivaria_recordatorios' : (motivo ?? undefined) };
  }
  if (reactivar) return reactivarRecordatorios(dialogId, chatId, botId, auth, estado, traspaso!, mensajes, visto);
  if (motivo) return { ...visto, retomado: false, motivo };

  // Sin nadie del equipo en el chat, Bitrix ya le entrega los mensajes al bot: el silencio es solo la
  // marca de traspaso y basta con levantarla. Con alguien dentro, hay que devolverle la sesión.
  const d = estado.equipo.length ? await devolverAlBot(chatId, botId, auth) : { ok: true, metodo: 'levantar_silencio', errores: [] as string[] };
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

/** Le devuelve al bot una derivación que nadie tomó y vuelve a armar la secuencia de recordatorios,
 *  contando la ventana de 24 h desde el último mensaje de la persona. No responde nada en el acto:
 *  el cliente no está esperando respuesta. */
async function reactivarRecordatorios(
  dialogId: string,
  chatId: string,
  botId: number,
  auth: Auth,
  estado: EstadoChat,
  traspaso: Traspaso,
  mensajes: Mensaje[],
  visto: Pick<ResultadoRetoma, 'dialogId' | 'equipoAntes' | 'botDentro' | 'pendientes'>,
): Promise<ResultadoRetoma> {
  // Un asesor que movió la negociación después de la derivación la está trabajando por fuera del
  // chat (una llamada, un correo): no se le cruza el bot.
  const entidades = await entidadesDelSeguimiento(dialogId);
  if (entidades?.deal && (await derivacionYaGestionada(entidades.deal, auth))) {
    return { ...visto, retomado: false, motivo: 'un_asesor_gestiona_la_negociacion' };
  }
  const d = estado.equipo.length ? await devolverAlBot(chatId, botId, auth) : { ok: true, metodo: 'levantar_silencio', errores: [] as string[] };
  const despues = await participantesDe(dialogId, auth).catch(() => [] as Participante[]);
  const botDentro = despues.some((u) => u.bot || String(u.id) === String(botId));
  if (!d.ok || !botDentro) {
    void audit({ type: 'retoma_fallida', dialogId, detail: { errores: d.errores, botDentro, para: 'reactivar_recordatorios' } }).catch(() => {});
    log.warn('reactivar recordatorios: Bitrix no le devolvió la sesión al bot', { dialogId, errores: d.errores, botDentro });
    return { ...visto, retomado: false, motivo: 'bitrix_no_devolvio_la_sesion', errores: d.errores, botDentro };
  }

  await borrarTraspaso(dialogId);
  const s = await getSession(dialogId);
  delete s.humanTookOver;
  await saveSession(dialogId, s);
  await programarSeguimiento(dialogId, entidades ?? undefined, traspaso.sesion, {
    clienteAt: estado.ultimaDelCliente,
    transcript: transcriptDelChat(mensajes, estado.clienteId),
  });
  const horas = Math.round(((Date.now() - traspaso.at) / 3600_000) * 10) / 10;
  void audit({ type: 'recordatorios_reactivados', dialogId, detail: { metodo: d.metodo, motivoDerivacion: traspaso.motivo, horasDesdeDerivacion: horas } }).catch(() => {});
  log.info('retomarChat: nadie tomó la derivación; vuelven los recordatorios', { dialogId, metodo: d.metodo, horas });
  return { ...visto, retomado: true, metodo: d.metodo, motivo: 'recordatorios_reactivados', errores: d.errores, botDentro };
}

/** Conversaciones con marca de traspaso (dialogId), sin repetidos. */
async function chatsTraspasados(): Promise<string[]> {
  const r = getRedisClient();
  if (!r) return [];
  const ids = new Set<string>();
  let cursor = '0';
  do {
    const [siguiente, claves] = await r.scan(cursor, 'MATCH', `${PREFIJO_TRASPASO}*`, 'COUNT', 200);
    cursor = siguiente;
    for (const clave of claves) ids.add(clave.slice(PREFIJO_TRASPASO.length));
  } while (cursor !== '0');
  return [...ids];
}

// Cada barrido revisa unas pocas conversaciones y el siguiente sigue donde quedó: las que nunca se
// resuelven (el cliente no volvió a escribir) no tapan a las demás.
let colaBarrido: string[] = [];

/** Recorre las conversaciones traspasadas y retoma las que quedaron sin respuesta. */
export async function barrerChatsTomados(): Promise<void> {
  if (!getRedisClient() || config.retomarChatHoras <= 0) return;
  if (!colaBarrido.length) colaBarrido = await chatsTraspasados();
  let revisados = 0;
  while (colaBarrido.length && revisados < MAX_POR_BARRIDO) {
    const dialogId = colaBarrido.shift()!;
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
}

/** Qué haría el barrido con cada conversación traspasada, sin tocar ninguna. */
async function simularBarrido(horas: number): Promise<ResultadoRetoma[]> {
  const out: ResultadoRetoma[] = [];
  for (const dialogId of (await chatsTraspasados()).slice(0, 100)) {
    const t = await leerTraspaso(dialogId);
    if (!t || Date.now() - t.at < horas * 3600_000) {
      out.push({ dialogId, retomado: false, retomaria: false, motivo: 'traspaso_reciente' });
      continue;
    }
    try {
      const r = await retomarChat(dialogId, { simular: true, horas });
      out.push({ ...r, retomaria: r.retomaria ?? false });
    } catch (e) {
      out.push({ dialogId, retomado: false, retomaria: false, motivo: `error: ${String(e).slice(0, 120)}` });
    }
  }
  return out;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function iniciarRetomaDeChats(): void {
  if (timer || config.retomarChatHoras <= 0 || !getRedisClient()) return;
  timer = setInterval(() => void barrerChatsTomados().catch((e) => log.warn('barrerChatsTomados', { err: String(e) })), INTERVALO_MS);
  timer.unref?.();
  log.info('retoma de chats tomados activa', { horas: config.retomarChatHoras, cadaMin: INTERVALO_MS / 60_000 });
}

/**
 * GET /setup/retomar-chat?chat=598649[&responder=0][&simular=1] — prueba en UN chat, sin esperar el plazo.
 * GET /setup/retomar-chat?todos=1[&horas=4] — simula el barrido sobre todas las conversaciones
 * traspasadas: cuáles retomaría y por qué no las demás. No toca nada ni muestra mensajes.
 */
export async function retomarChatManual(req: Request, res: Response) {
  if (req.query.todos === '1') {
    const horas = Number(req.query.horas ?? 4) || 4;
    const chats = await simularBarrido(horas);
    return res.json({ ok: true, horas, total: chats.length, retomaria: chats.filter((c) => c.retomaria).length, chats });
  }
  const chat = String(req.query.chat ?? '').replace(/\D/g, '');
  if (!chat) return res.status(400).json({ ok: false, error: 'Falta ?chat=<id> o ?todos=1' });
  const r = await retomarChat(`chat${chat}`, { forzar: true, responder: req.query.responder !== '0', simular: req.query.simular === '1' });
  res.json({ ok: true, ...r });
}
