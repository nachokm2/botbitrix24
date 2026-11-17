import { anthropic, REASONER } from '../ai/client';
import { getHistory, setHistory } from '../ai/memory';
import { callBitrix } from '../bitrix/client';
import { log } from '../log';
import { audit } from '../obs/audit';
import { inc, recordTokens } from '../obs/metrics';
import { getJson, setJson, kvDel, once } from '../store/kv';
import type { Auth } from '../store';
import { avisarEquipoInternacional, destinatariosInternacional, modoInternacionalConfigurado } from './internacional';

/**
 * Modo internacional: lo que el bot no sabe se lo consulta a una persona del equipo por el chat
 * privado del bot en Bitrix, y la respuesta vuelve a la persona en su idioma.
 *
 * Pedido del usuario (17-11-2026): en India no hay quién atienda por teléfono ni hable inglés o hindi,
 * así que el bot atiende solo y nunca traspasa; si no sabe algo, le avisa a él, que lo revisa y da la
 * respuesta. Escribir directo en el chat no servía: el bot se calla el resto de la sesión en cuanto
 * escribe una persona (Sumantra, 16-11). Por eso la respuesta pasa por el bot.
 *
 * Cómo se responde: citando el aviso (o empezando con su código, #K7Q2) en el chat privado con el bot,
 * en español. El bot la redacta en el idioma de la persona y le confirma qué envió. Si la persona
 * escribió hace más de 23,5 h, WhatsApp no deja escribirle: la respuesta queda guardada y el bot se la
 * da en cuanto vuelva a escribir (ver bloqueRespuestaPendiente).
 */

export type Consulta = {
  codigo: string;
  dialogId: string;
  motivo: string;
  mensajeCliente: string;
  nombre?: string;
  dealId?: number;
  pago?: boolean;
  at: number;
  estado: 'abierta' | 'enviada' | 'guardada';
};

const CONSULTA_KEY = (codigo: string) => `internacional:consulta:${codigo}`;
const MENSAJE_KEY = (messageId: string | number) => `internacional:consulta:msg:${messageId}`;
const ABIERTAS_KEY = 'internacional:consultas:abiertas';
const CLIENTE_AT_KEY = (dialogId: string) => `internacional:cliente_at:${dialogId}`;
const PENDIENTE_KEY = (dialogId: string) => `internacional:respuesta_pendiente:${dialogId}`;
const TTL_SEG = 14 * 86400;
// WhatsApp deja escribir texto libre hasta 24 h después del último mensaje de la persona.
const VENTANA_MS = 23.5 * 3600_000;
// Sin letras parecidas entre sí (0/O, 1/I/L, 5/S, 8/B), para que se pueda escribir a mano.
const ALFABETO = 'ACDEFGHJKMNPQRTUVWXY34679';

function nuevoCodigo(): string {
  let c = '';
  for (let i = 0; i < 4; i++) c += ALFABETO[Math.floor(Math.random() * ALFABETO.length)];
  return c;
}

/** Cuándo escribió la persona por última vez (lo registra botEvents en cada mensaje del modo). */
export async function marcarMensajeDelCliente(dialogId: string, ahora = Date.now()): Promise<void> {
  await setJson(CLIENTE_AT_KEY(dialogId), ahora, 30 * 86400).catch(() => {});
}

async function abiertas(): Promise<string[]> {
  return (await getJson<string[]>(ABIERTAS_KEY)) ?? [];
}

async function guardarAbiertas(codigos: string[]): Promise<void> {
  await setJson(ABIERTAS_KEY, codigos.slice(-50), TTL_SEG);
}

/** Texto del aviso que recibe la persona del equipo. */
export function textoAviso(c: Consulta, dominio?: string): string {
  const titulo = c.pago
    ? `[B]💳 Consulta #${c.codigo} · programa internacional: un alumno dice que pagó[/B]`
    : `[B]❓ Consulta #${c.codigo} · programa internacional: el bot no sabe la respuesta[/B]`;
  const enlaces = dominio
    ? [
        `[URL=https://${dominio}/online/?IM_DIALOG=${c.dialogId}]Abrir el chat[/URL]`,
        c.dealId ? `[URL=https://${dominio}/crm/deal/details/${c.dealId}/]Negociación[/URL]` : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  return [
    titulo,
    c.nombre ? `Persona: ${c.nombre}` : '',
    c.motivo,
    c.mensajeCliente ? `Escribió: «${c.mensajeCliente.slice(0, 400)}»` : '',
    c.pago
      ? 'Si quiere decirle algo, responda este mensaje en español y se lo envío en su idioma.'
      : 'Para contestarle, responda este mensaje (o empiece con el código) en español: se lo envío en su idioma y le confirmo qué le mandé. No escriba directo en el chat de la persona: el bot deja de atenderla.',
    enlaces,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Registra la consulta y se la manda por el chat privado del bot a cada persona del equipo. Si Bitrix
 * no deja escribirle por privado, va como notificación (sin poder responderla desde ahí). Devuelve a
 * cuántas personas les llegó.
 */
export async function crearConsulta(
  a: { dialogId: string; motivo: string; mensajeCliente?: string; nombre?: string; dealId?: number; pago?: boolean; botId?: number },
  auth: Auth,
): Promise<{ codigo: string; avisados: number }> {
  let codigo = nuevoCodigo();
  for (let i = 0; i < 5 && !(await once(`${CONSULTA_KEY(codigo)}:reservado`, TTL_SEG)); i++) codigo = nuevoCodigo();
  const c: Consulta = {
    codigo,
    dialogId: a.dialogId,
    motivo: a.motivo,
    mensajeCliente: String(a.mensajeCliente ?? '').trim(),
    nombre: a.nombre,
    dealId: a.dealId,
    pago: a.pago,
    at: Date.now(),
    estado: 'abierta',
  };
  await setJson(CONSULTA_KEY(codigo), c, TTL_SEG);
  await guardarAbiertas([...(await abiertas()).filter((x) => x !== codigo), codigo]);

  const texto = textoAviso(c, auth.domain);
  let avisados = 0;
  for (const userId of destinatariosInternacional()) {
    try {
      if (!a.botId) throw new Error('sin botId');
      const r = await callBitrix<unknown>('imbot.message.add', { BOT_ID: a.botId, DIALOG_ID: String(userId), MESSAGE: texto }, auth);
      // Bitrix devuelve el id del mensaje: con él se reconoce la respuesta hecha con «Responder».
      if (typeof r === 'number' || (typeof r === 'string' && /^\d+$/.test(r))) await setJson(MENSAJE_KEY(r), codigo, TTL_SEG);
      avisados++;
    } catch (e) {
      log.warn('consulta internacional: no se pudo escribir por privado; va como notificación', { userId, err: String(e) });
    }
  }
  if (!avisados) {
    // Por notificación no se puede responder: se le dice cómo hacerlo (escribiéndole al bot con el código).
    const [titulo, ...resto] = textoAviso(c).split('\n');
    avisados = await avisarEquipoInternacional(
      {
        dialogId: a.dialogId,
        titulo: titulo.replace(/\[\/?B\]/g, ''),
        detalle: resto.join('\n').replace(/responda este mensaje( \(o empiece con el código\))?/, `escríbale al bot «#${codigo}» seguido de la respuesta`),
      },
      auth,
    );
  }
  return { codigo, avisados };
}

/** Lo que le devuelve la herramienta al modelo tras crear la consulta (también en el simulador). */
export function resultadoConsultaParaElModelo(pago: boolean): string {
  return pago
    ? 'Noted for confirmation. Thank them, and tell them in their language that their payment will be confirmed and their access sent by email. Do not promise a time, and do not mention a team or a person.'
    : 'Your question is being checked. Tell them in their language that you are checking that detail and will write back here with the answer. Do not mention a team, a person, a colleague or a call, do not promise a time, and keep helping with anything you can answer from PROGRAMME FACTS.';
}

/** ¿El evento es alguien del equipo escribiéndole al bot por privado? Solo con el modo configurado. */
export function esMensajeDelEquipo(dialogId: string | undefined, fromUserId: unknown): boolean {
  if (!modoInternacionalConfigurado()) return false;
  const de = String(fromUserId ?? '');
  if (!dialogId || !/^\d+$/.test(dialogId) || dialogId !== de) return false;
  return destinatariosInternacional().includes(Number(de));
}

const SEPARADOR_CITA = /^-{20,}\s*$/m;

/** Separa la cita de Bitrix (bloque entre líneas de guiones) de lo que escribió la persona. */
export function separarCita(texto: string): { citado: string; propio: string } {
  const lineas = String(texto ?? '').split(/\r?\n/);
  const marcas = lineas.map((l, i) => (SEPARADOR_CITA.test(l) ? i : -1)).filter((i) => i >= 0);
  if (marcas.length < 2) return { citado: '', propio: String(texto ?? '').trim() };
  const [ini, fin] = [marcas[0], marcas[marcas.length - 1]];
  return {
    citado: lineas.slice(ini + 1, fin).join('\n'),
    propio: [...lineas.slice(0, ini), ...lineas.slice(fin + 1)].join('\n').trim(),
  };
}

/** De qué consulta habla la respuesta: el código citado o escrito, la respuesta de Bitrix, o la única abierta. */
export function elegirConsulta(
  a: { citado: string; propio: string; replyCodigo?: string | null },
  abiertasAhora: string[],
): { codigo: string | null; respuesta: string; motivo?: 'varias' | 'ninguna' } {
  const enCita = /#([A-Z0-9]{4})\b/.exec(a.citado)?.[1];
  const alInicio = /^\s*#?([A-Z0-9]{4})\b[\s:.\-–]*/i.exec(a.propio);
  const escrito = alInicio && abiertasAhora.includes(alInicio[1].toUpperCase()) ? alInicio[1].toUpperCase() : null;
  const respuesta = escrito && alInicio ? a.propio.slice(alInicio[0].length).trim() : a.propio.trim();
  const codigo = enCita ?? a.replyCodigo ?? escrito ?? (abiertasAhora.length === 1 ? abiertasAhora[0] : null);
  if (codigo) return { codigo, respuesta };
  return { codigo: null, respuesta, motivo: abiertasAhora.length ? 'varias' : 'ninguna' };
}

/** Instrucciones para pasar la respuesta del equipo al idioma de la persona. */
export const REDACTOR_RESPUESTA_EQUIPO =
  "You are Carver University's admissions assistant on WhatsApp. Earlier you told this person you would check a detail and " +
  'write back. The admissions office has now given you the answer, in Spanish. Write ONE WhatsApp message to the person ' +
  'that gives them that answer. Rules: write in the language and script the person uses in the conversation (English by ' +
  'default; Hindi in Devanagari if they type in Devanagari; Hinglish with Latin letters if they type Hindi with Latin ' +
  'letters; never Spanish unless they write in Spanish), with the respectful form ("aap" in Hindi and Hinglish). Start ' +
  'by linking it to what they asked in a few words (for example "About your question on the certificate:"). Keep every ' +
  'fact, figure, amount, date, name, email and link of the answer EXACTLY as written, and add nothing that is not in ' +
  'it. Do not mention the admissions office, the team, a person, a colleague or that it was translated: you are simply ' +
  'giving them the answer. Short, warm and professional, no emojis, no bold, no headings. Return ONLY the message.';

function textoPlano(m: any): string {
  if (typeof m?.content === 'string') return m.content;
  if (Array.isArray(m?.content)) return m.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join(' ');
  return '';
}

const montosYEnlaces = (t: string) => [
  ...(t.match(/(usd|us\$|inr|₹|rs\.?|\$)\s?\d[\d.,]*/gi) ?? []).map((x) => x.replace(/\s+/g, '').replace(/[.,]$/, '').toLowerCase()),
  ...(t.match(/https?:\/\/[^\s)\]]+/g) ?? []).map((u) => u.replace(/[.,;:]+$/, '')),
];

/** El mensaje en el idioma de la persona; null si no conserva montos y enlaces de la respuesta. */
export async function redactarRespuesta(c: Consulta, respuesta: string, historial: any[]): Promise<string | null> {
  const conversacion = historial
    .slice(-10)
    .map((m) => ({ quien: m.role === 'assistant' ? 'Assistant' : 'Person', texto: textoPlano(m).trim() }))
    .filter((x) => x.texto && !x.texto.startsWith('['))
    .map((x) => `${x.quien}: ${x.texto.slice(0, 600)}`)
    .join('\n');
  const resp = await anthropic.messages.create({
    model: REASONER,
    max_tokens: 700,
    temperature: 0,
    system: REDACTOR_RESPUESTA_EQUIPO,
    messages: [
      {
        role: 'user',
        content:
          `Recent conversation:\n${conversacion || '(not available)'}\n\n` +
          `What they asked (summary in Spanish): ${c.motivo}\n` +
          (c.mensajeCliente ? `Their exact words: ${c.mensajeCliente}\n` : '') +
          `\nAnswer from the admissions office (Spanish):\n${respuesta}\n\nWrite the message.`,
      },
    ],
  });
  recordTokens((resp as any).usage);
  const texto = (resp.content as any[])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
    .replace(/\*\*/g, '');
  if (!texto) return null;
  const duros = montosYEnlaces(texto);
  return montosYEnlaces(respuesta).every((d) => duros.includes(d)) ? texto : null;
}

async function responderAlEquipo(userId: string, texto: string, botId: number, auth: Auth): Promise<void> {
  try {
    await callBitrix('imbot.message.add', { BOT_ID: botId, DIALOG_ID: userId, MESSAGE: texto }, auth);
  } catch (e) {
    log.warn('consulta internacional: no se pudo contestar por privado', { userId, err: String(e) });
  }
}

/** Cuándo escribió la persona por última vez: lo registrado por el modo o, si no, `respaldo`. */
async function ultimoDelCliente(dialogId: string, respaldo?: () => Promise<number | null>): Promise<number | null> {
  return (await getJson<number>(CLIENTE_AT_KEY(dialogId))) ?? (respaldo ? await respaldo().catch(() => null) : null);
}

/**
 * Lo que escribe alguien del equipo por privado: una respuesta a una consulta, o «pendientes» para ver
 * las abiertas. `respaldoClienteAt` lee la hora del último mensaje de la persona de otra fuente
 * (la instantánea de los recordatorios) para los chats anteriores a este registro.
 */
export async function procesarMensajeDelEquipo(a: {
  fromUserId: string;
  mensaje: string;
  replyId?: string | number | null;
  botId: number;
  auth: Auth;
  respaldoClienteAt?: (dialogId: string) => Promise<number | null>;
  ahora?: number;
}): Promise<'enviada' | 'guardada' | 'lista' | 'sin_consulta' | 'sin_texto' | 'error'> {
  const ahora = a.ahora ?? Date.now();
  const lista = await abiertas();
  const { citado, propio } = separarCita(a.mensaje);

  if (/^(pendientes|consultas|ayuda)\??$/i.test(propio)) {
    const filas = (await Promise.all(lista.map((k) => getJson<Consulta>(CONSULTA_KEY(k))))).filter(
      (c): c is Consulta => !!c && c.estado === 'abierta',
    );
    await responderAlEquipo(
      a.fromUserId,
      filas.length
        ? `Consultas sin responder (${filas.length}):\n${filas.map((c) => `#${c.codigo} · ${c.nombre ?? 'sin nombre'} · ${c.motivo.slice(0, 120)}`).join('\n')}\nPara contestar una, escriba su código y la respuesta, por ejemplo «#${filas[0].codigo} Sí, el certificado es digital».`
        : 'No hay consultas sin responder.',
      a.botId,
      a.auth,
    );
    return 'lista';
  }

  const replyCodigo = a.replyId ? await getJson<string>(MENSAJE_KEY(a.replyId)) : null;
  const eleccion = elegirConsulta({ citado, propio, replyCodigo }, lista);
  if (!eleccion.codigo) {
    await responderAlEquipo(
      a.fromUserId,
      eleccion.motivo === 'varias'
        ? `Hay ${lista.length} consultas sin responder y no sé a cuál corresponde. Responda el aviso de la consulta, o empiece con su código, por ejemplo «#${lista[lista.length - 1]} …». Escriba «pendientes» para verlas.`
        : 'No hay consultas sin responder. Cuando el bot no sepa algo, le llegará un aviso con un código.',
      a.botId,
      a.auth,
    );
    return 'sin_consulta';
  }
  const c = await getJson<Consulta>(CONSULTA_KEY(eleccion.codigo));
  if (!c) {
    await responderAlEquipo(a.fromUserId, `No encuentro la consulta #${eleccion.codigo}: puede haber vencido (duran 14 días).`, a.botId, a.auth);
    return 'sin_consulta';
  }
  if (!eleccion.respuesta) {
    await responderAlEquipo(a.fromUserId, `Escriba la respuesta para la consulta #${c.codigo} en el mismo mensaje.`, a.botId, a.auth);
    return 'sin_texto';
  }

  const cerrar = async (estado: Consulta['estado']) => {
    await setJson(CONSULTA_KEY(c.codigo), { ...c, estado }, TTL_SEG);
    await guardarAbiertas((await abiertas()).filter((x) => x !== c.codigo));
  };

  const clienteAt = await ultimoDelCliente(c.dialogId, a.respaldoClienteAt ? () => a.respaldoClienteAt!(c.dialogId) : undefined);
  if (!clienteAt || ahora - clienteAt > VENTANA_MS) {
    await setJson(PENDIENTE_KEY(c.dialogId), { codigo: c.codigo, motivo: c.motivo, respuesta: eleccion.respuesta, at: ahora }, TTL_SEG);
    await cerrar('guardada');
    const horas = clienteAt ? Math.round((ahora - clienteAt) / 3600_000) : null;
    await responderAlEquipo(
      a.fromUserId,
      `Guardé la respuesta de la consulta #${c.codigo}. ${horas !== null ? `La persona escribió por última vez hace ${horas} h` : 'No sé cuándo escribió la persona por última vez'} y WhatsApp no deja escribirle pasadas 24 h: se la doy en cuanto vuelva a escribir.`,
      a.botId,
      a.auth,
    );
    void audit({ type: 'respuesta_equipo', dialogId: c.dialogId, detail: { codigo: c.codigo, estado: 'guardada', de: a.fromUserId } }).catch(() => {});
    inc('respuesta_equipo_guardada');
    return 'guardada';
  }

  try {
    const historial = await getHistory(c.dialogId);
    const mensaje = await redactarRespuesta(c, eleccion.respuesta, historial);
    if (!mensaje) {
      await responderAlEquipo(
        a.fromUserId,
        `No pude redactar la respuesta de la consulta #${c.codigo} conservando sus cifras y enlaces, así que no envié nada. Pruebe escribirla de nuevo, con los montos y enlaces tal como deben salir.`,
        a.botId,
        a.auth,
      );
      return 'error';
    }
    await callBitrix('imbot.message.add', { BOT_ID: a.botId, DIALOG_ID: c.dialogId, MESSAGE: mensaje }, a.auth);
    await setHistory(c.dialogId, [...historial, { role: 'assistant', content: mensaje }]);
    await cerrar('enviada');
    await responderAlEquipo(a.fromUserId, `✅ Le envié a ${c.nombre ?? 'la persona'} (consulta #${c.codigo}):\n«${mensaje}»`, a.botId, a.auth);
    void audit({ type: 'respuesta_equipo', dialogId: c.dialogId, detail: { codigo: c.codigo, estado: 'enviada', de: a.fromUserId, mensaje } }).catch(() => {});
    inc('respuesta_equipo_enviada');
    return 'enviada';
  } catch (e) {
    log.warn('consulta internacional: no se pudo enviar la respuesta', { codigo: c.codigo, dialogId: c.dialogId, err: String(e) });
    await responderAlEquipo(
      a.fromUserId,
      `No se pudo enviar la respuesta de la consulta #${c.codigo} (${String(e).slice(0, 120)}). Puede intentarlo de nuevo respondiendo el aviso.`,
      a.botId,
      a.auth,
    );
    return 'error';
  }
}

/**
 * Si el equipo respondió una consulta cuando la persona ya estaba fuera de las 24 h, el bot se la da en
 * el primer turno en que vuelva a escribir. Se consume al leerla.
 */
export async function bloqueRespuestaPendiente(dialogId: string): Promise<string> {
  const p = await getJson<{ codigo: string; motivo: string; respuesta: string }>(PENDIENTE_KEY(dialogId));
  if (!p) return '';
  await kvDel(PENDIENTE_KEY(dialogId));
  return (
    `\n\nTURN NOTE (strict): earlier you told this person you would check something for them (${p.motivo}). The answer, in Spanish, is: ` +
    `«${p.respuesta}». In this reply, first answer what they just wrote, then give them that answer in their language, with every ` +
    'fact, figure and link exactly as written, without mentioning a team, a person or a translation.'
  );
}
