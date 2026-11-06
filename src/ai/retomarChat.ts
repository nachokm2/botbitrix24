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
import { asesorSinBotACargo } from '../crm/asesorSinBot';
import { resolveAllEntities } from '../crm/chat';
import { procesarMensajeSintetico } from '../routes/botEvents';
import { audit } from '../obs/audit';
import { log } from '../log';
import { avisarSiEspera, esEcoDeEnvio, VENTANA_WHATSAPP_MS, DERIVACIONES_DEL_BOT } from './avisoEspera';

/**
 * Qué hacer con una conversación que una persona tomó y dejó sin responder.
 *
 * Cuando una asesora toma un chat —lo intercepta, o el bot se lo deriva—, el bot calla mientras dure
 * la marca de traspaso (30 días). Un sábado quedaron cuatro clientes esperando a una asesora que volvía
 * el lunes (31-10-2026), dos de ellos a mitad de la ficha de matrícula.
 *
 * Cada 10 minutos se revisan las conversaciones traspasadas:
 * - Con una persona del equipo dentro del chat, el bot no puede retomarlo: Bitrix rechaza traspasarle
 *   la sesión a un bot (OPERATOR_WRONG en todos los intentos del 03 al 05-11-2026). Si el cliente
 *   espera, se avisa a quien puede responder (ai/avisoEspera.ts).
 * - Si la persona ya salió y el bot sigue dentro, Bitrix le entrega los mensajes y el bot calla solo por
 *   la marca (chat 598649: tres mensajes sin respuesta, con la asesora fuera del chat desde el 14-10).
 *   Ahí basta con levantar la marca: si el cliente espera hace RETOMAR_CHAT_HORAS, el bot responde lo
 *   pendiente; si fue una derivación que nadie tomó, vuelven los recordatorios.
 */

const INTERVALO_MS = 10 * 60_000;
// Los avisos salen a las 2 h: con un par de cientos de traspasos vigentes, 40 por barrido recorren
// todos en menos de una hora (unas 3 llamadas a Bitrix por chat).
const MAX_POR_BARRIDO = 40;

type Participante = { id?: number | string; name?: string; bot?: boolean; extranet?: boolean; connector?: boolean };
type Mensaje = { id?: number | string; author_id?: number | string; date?: string; text?: string };

export type EstadoChat = {
  /** Personas del equipo dentro del chat (no el bot, no el cliente). */
  equipo: string[];
  /** El bot sigue en el chat: Bitrix le entrega los mensajes aunque calle. */
  botDentro: boolean;
  clienteId: string | null;
  /** Lo que el cliente escribió después de la última respuesta de alguien (bot o equipo). */
  pendientes: string[];
  /** Los mismos, con la hora de cada uno (ms). */
  pendientesConFecha: { texto: string; at: number }[];
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
    if (esEcoDeEnvio(String(m.text ?? ''))) continue; // el brochure que mandó el bot, devuelto a nombre del cliente
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
    pendientesConFecha: pendientes.map(({ texto, at }) => ({ texto, at })),
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

/**
 * La otra mitad: una derivación que NADIE tomó y en la que el cliente tampoco espera respuesta (lo
 * último lo dijo el bot). Al derivar se apagan los recordatorios; si después nadie le escribe, el
 * lead queda solo. Carver, 25-10 al 03-11-2026: 8 leads con puntaje alto pasaron 24 h así.
 * Devuelve el motivo para NO devolverle el chat al bot con los recordatorios, o null.
 */
export function motivoParaNoReactivar(e: EstadoChat, t: { at: number; motivo: string }, horas: number, ahora = Date.now()): string | null {
  if (horas <= 0) return 'apagado';
  // Si un asesor entró al chat ('operador') o era horario de asesores, el chat es de ellos aunque
  // lleven horas sin escribir.
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
    .filter((m) => String(m.author_id ?? '0') !== '0' && String(m.text ?? '').trim() && !esEcoDeEnvio(String(m.text)))
    .map((m) => `${clienteId && String(m.author_id) === clienteId ? 'Cliente' : 'Bot'}: ${String(m.text).replace(/\s+/g, ' ').trim()}`)
    .join('\n');
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
  equipoAntes?: string[];
  botDentro?: boolean;
  respondido?: boolean;
  /** Mensajes del cliente sin respuesta (cuántos, no cuáles). */
  pendientes?: number;
  /** Avisos de cliente esperando que salieron (o saldrían, en simulación): 1 = equipo, 2 = escalado. */
  avisos?: number[];
  /** Solo en simulación: si lo habría retomado. */
  retomaria?: boolean;
};

/**
 * Evalúa una conversación traspasada. Con una persona del equipo dentro, avisa si el cliente espera;
 * sin nadie, si corresponde (o si `forzar`), el bot responde lo pendiente. `forzar` salta el reloj de
 * horas del bot, no las demás condiciones ni los plazos de los avisos: es para probar en un chat
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

  // Negociación de un asesor que atiende sin el bot (crm/asesorSinBot.ts): ni se retoma, ni vuelven los
  // recordatorios, ni se avisa que el cliente espera. Sin la variable no se consulta nada.
  if (config.asesoresSinBot.length && (await asesorSinBotACargo(await resolveAllEntities({}, chatId, auth), auth))) {
    return { dialogId, retomado: false, motivo: 'asesor_sin_bot' };
  }

  const traspaso = await leerTraspaso(dialogId);
  const [participantes, crudo] = await Promise.all([
    participantesDe(dialogId, auth),
    callBitrix<any>('im.dialog.messages.get', { DIALOG_ID: dialogId, LIMIT: 30 }, auth),
  ]);
  const mensajes: Mensaje[] = Array.isArray(crudo) ? crudo : (crudo?.messages ?? []);
  const estado = leerEstado(participantes, mensajes, botId);
  const visto = { dialogId, equipoAntes: estado.equipo, botDentro: estado.botDentro, pendientes: estado.pendientes.length };

  // Con alguien del equipo dentro, el bot no puede retomar: Bitrix rechaza traspasarle la sesión
  // (OPERATOR_WRONG). Se avisa a quien sí puede responder.
  if (estado.equipo.length) {
    const avisos = await avisarSiEspera({ dialogId, chatId, estado, traspaso, participantes, auth, authAvisos: st.auth ?? auth, simular: opts.simular });
    return { ...visto, retomado: false, motivo: 'persona_a_cargo', avisos, ...(opts.simular ? { retomaria: false } : {}) };
  }

  // En horario de asesores el bot devuelve el chat a la cola apenas lo recibe: retomarlo sería un
  // ida y vuelta sin respuesta.
  if (asesoresDisponibles()) return { ...visto, retomado: false, motivo: 'horario_de_asesores' };
  // El barrido también corre solo por los avisos: sin RETOMAR_CHAT_HORAS, el bot no retoma nada.
  if (config.retomarChatHoras <= 0 && !opts.forzar && !opts.simular) return { ...visto, retomado: false, motivo: 'retomar_apagado' };

  const horas = opts.forzar ? 0 : (opts.horas ?? config.retomarChatHoras);
  const motivo = motivoParaNoRetomar(estado, traspaso?.at ?? 0, horas);
  // Nadie espera respuesta, pero puede ser una derivación que nadie tomó: entonces se reactivan los
  // recordatorios en vez de dejar al lead solo.
  const reactivar =
    motivo === 'el_cliente_no_espera_respuesta' && !opts.forzar && traspaso !== null &&
    motivoParaNoReactivar(estado, traspaso, config.reactivarSinTomarHoras) === null;
  if (opts.simular) {
    return { ...visto, retomado: false, retomaria: !motivo || reactivar, motivo: reactivar ? 'reactivaria_recordatorios' : (motivo ?? undefined) };
  }
  if (reactivar) return reactivarRecordatorios(dialogId, auth, estado, traspaso!, mensajes, visto);
  if (motivo) return { ...visto, retomado: false, motivo };

  // Sin nadie del equipo en el chat y con el bot dentro, Bitrix ya le entrega los mensajes al bot: el
  // silencio es solo la marca de traspaso y basta con levantarla. Se olvida también el estado de
  // "humano a cargo". La memoria del bot se vacía a propósito: no vio lo que conversó la asesora, y en
  // el próximo turno lee los últimos 30 mensajes del chat (ver crm/historialChat.ts), así retoma desde
  // ahí sin contradecirla.
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
  void audit({ type: 'chat_retomado', dialogId, detail: { metodo: 'levantar_silencio', pendientes: estado.pendientes.length, forzado: Boolean(opts.forzar) } }).catch(() => {});
  log.info('retomarChat: el bot retomó la conversación', { dialogId, metodo: 'levantar_silencio', pendientes: estado.pendientes.length });
  return { ...visto, retomado: true, metodo: 'levantar_silencio', respondido };
}

/** Una derivación que nadie tomó, con el bot solo en el chat: se levanta la marca de traspaso y se
 *  vuelve a armar la secuencia de recordatorios, contando la ventana de 24 h desde el último mensaje
 *  de la persona. No responde nada en el acto: el cliente no está esperando respuesta. */
async function reactivarRecordatorios(
  dialogId: string,
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

  await borrarTraspaso(dialogId);
  const s = await getSession(dialogId);
  delete s.humanTookOver;
  await saveSession(dialogId, s);
  await programarSeguimiento(dialogId, entidades ?? undefined, traspaso.sesion, {
    clienteAt: estado.ultimaDelCliente,
    transcript: transcriptDelChat(mensajes, estado.clienteId),
  });
  const horas = Math.round(((Date.now() - traspaso.at) / 3600_000) * 10) / 10;
  void audit({ type: 'recordatorios_reactivados', dialogId, detail: { metodo: 'levantar_silencio', motivoDerivacion: traspaso.motivo, horasDesdeDerivacion: horas } }).catch(() => {});
  log.info('retomarChat: nadie tomó la derivación; vuelven los recordatorios', { dialogId, horas });
  return { ...visto, retomado: true, metodo: 'levantar_silencio', motivo: 'recordatorios_reactivados' };
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

/** El barrido corre si el bot puede retomar chats o si hay que avisar de clientes esperando. */
const barridoActivo = () => config.retomarChatHoras > 0 || config.avisoEsperaHoras > 0;
/** Antes de este plazo desde el traspaso no hay nada que hacer todavía: ni retomar ni avisar. */
const plazoMinimoMs = () => Math.min(...[config.retomarChatHoras, config.avisoEsperaHoras].filter((h) => h > 0)) * 3600_000;

/** Recorre las conversaciones traspasadas: retoma las que quedaron sin respuesta con el bot solo
 *  dentro, y avisa por las que tienen a un cliente esperando a una persona. */
export async function barrerChatsTomados(): Promise<void> {
  if (!getRedisClient() || !barridoActivo()) return;
  if (!colaBarrido.length) colaBarrido = await chatsTraspasados();
  let revisados = 0;
  while (colaBarrido.length && revisados < MAX_POR_BARRIDO) {
    const dialogId = colaBarrido.shift()!;
    const t = await leerTraspaso(dialogId);
    // Sin el plazo cumplido desde el traspaso no hay nada que mirar todavía: ahorra llamadas.
    if (!t || Date.now() - t.at < plazoMinimoMs()) continue;
    revisados++;
    try {
      const res = await retomarChat(dialogId);
      if (res.retomado) log.info('barrido de chats tomados', res);
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
  if (timer || !barridoActivo() || !getRedisClient()) return;
  timer = setInterval(() => void barrerChatsTomados().catch((e) => log.warn('barrerChatsTomados', { err: String(e) })), INTERVALO_MS);
  timer.unref?.();
  log.info('retoma de chats tomados activa', {
    horas: config.retomarChatHoras,
    avisoHoras: config.avisoEsperaHoras,
    avisoEscalarHoras: config.avisoEsperaEscalarHoras,
    cadaMin: INTERVALO_MS / 60_000,
  });
}

/**
 * GET /setup/retomar-chat?chat=598649[&responder=0][&simular=1] — prueba en UN chat, sin esperar el
 * plazo del bot. Con una persona dentro del chat evalúa los avisos, con sus plazos de siempre.
 * GET /setup/retomar-chat?todos=1[&horas=4] — simula el barrido sobre todas las conversaciones
 * traspasadas: cuáles retomaría, de cuáles avisaría y por qué no las demás. No toca nada ni muestra
 * mensajes.
 */
export async function retomarChatManual(req: Request, res: Response) {
  if (req.query.todos === '1') {
    const horas = Number(req.query.horas ?? 4) || 4;
    const chats = await simularBarrido(horas);
    return res.json({
      ok: true,
      horas,
      total: chats.length,
      retomaria: chats.filter((c) => c.retomaria).length,
      avisaria: chats.filter((c) => c.avisos?.length).length,
      chats,
    });
  }
  const chat = String(req.query.chat ?? '').replace(/\D/g, '');
  if (!chat) return res.status(400).json({ ok: false, error: 'Falta ?chat=<id> o ?todos=1' });
  const r = await retomarChat(`chat${chat}`, { forzar: true, responder: req.query.responder !== '0', simular: req.query.simular === '1' });
  res.json({ ok: true, ...r });
}
