import crypto from 'crypto';
import type { Request, Response } from 'express';
import { dbEventosInternacionales } from '../store/db';
import { cuantasConsultasAbiertas } from '../core/consultasInternacionales';
import { esSinContenido, soloMensajeDelAnuncio } from '../core/ruidoInternacional';
import { calcularResumen, type FilaEvento } from '../ai/resumenInternacional';
import { log } from '../log';

/**
 * Datos del piloto internacional para el informe diario que actualiza un agente en la nube (pedido del
 * 18-11-2026: «actualízalo a las 9:30 todos los días para que Ignacio lo vea»). El agente no tiene acceso
 * a Railway ni a la base, así que lee esto.
 *
 * Protegido con INFORME_INTERNACIONAL_TOKEN (sin la variable, no existe). Lleva cifras y las
 * conversaciones de las últimas 24 h con teléfonos y correos ocultos: el agente las lee para contar
 * quién mostró interés, como se hizo a mano hasta ahora.
 */

const DIA_TZ = 'America/Santiago';
const diaEnChile = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: DIA_TZ }).format(new Date(ms));
const ms = (x: Date | string) => (x instanceof Date ? x.getTime() : Date.parse(String(x)));

/** Oculta teléfonos, correos y enlaces de un texto que sale del bot. */
export function ocultarDatos(texto: string): string {
  return String(texto ?? '')
    .replace(/\[URL=[^\]]*\][^[]*\[\/URL\]/gi, '[link]')
    .replace(/https?:\/\/\S+/g, '[link]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[correo]')
    .replace(/\+?\d[\d\s-]{8,}\d/g, '[teléfono]')
    .replace(/\s+/g, ' ')
    .trim();
}

/** ¿El mensaje dice algo? (no es el anuncio, enlaces, emojis ni una foto sin texto). */
function conContenido(msg: string): boolean {
  return !soloMensajeDelAnuncio([msg]) && !esSinContenido(msg) && /\p{L}{3}/u.test(msg.replace(/\[URL=[^\]]*\][^[]*\[\/URL\]|https?:\/\/\S+/g, ''));
}

export type FilaInforme = FilaEvento & { crm_entity?: string | null };

/** Arma el informe con las filas de auditoría del modo internacional. Pura. */
export function armarInforme(filas: FilaInforme[], ahora = Date.now(), consultasAbiertas = 0) {
  const desde24 = ahora - 24 * 3600_000;
  type Chat = {
    primero: number;
    deal: number | null;
    mensajes: string[];
    turnos: Array<{ ts: number; cliente: string; bot: string }>;
    todos: Array<{ ts: number; cliente: string; bot: string }>;
    senales: Set<string>;
  };
  const chats = new Map<string, Chat>();
  const chat = (f: FilaInforme) => {
    let c = chats.get(f.dialog_id);
    if (!c) {
      c = { primero: ms(f.primero), deal: null, mensajes: [], turnos: [], todos: [], senales: new Set() };
      chats.set(f.dialog_id, c);
    }
    const deal = /deal#(\d+)/.exec(String(f.crm_entity ?? ''))?.[1];
    if (deal) c.deal = Number(deal);
    return c;
  };
  const tot = { recordatoriosEnviados: 0, recordatoriosRespondidos: 0, recordatoriosOmitidosNoProspecto: 0, silenciosSinContenido: 0, audios: 0 };
  for (const f of filas) {
    const d = f.detail ?? {};
    const ts = ms(f.ts);
    if (f.type === 'turn' && d.internacional) {
      const c = chat(f);
      const msg = String(d.message ?? '');
      c.mensajes.push(msg);
      if (/\[voice message\]|could not be transcribed/i.test(msg)) tot.audios++;
      const t = { ts, cliente: ocultarDatos(msg).slice(0, 400), bot: ocultarDatos(String(d.reply ?? '')).slice(0, 400) };
      if (ts >= desde24) c.turnos.push(t);
      c.todos.push(t);
      if (d.variante) c.senales.add(`variante_${d.variante}`);
    } else if (chats.has(f.dialog_id) || f.type !== 'turn') {
      const c = chat(f);
      if (f.type === 'tool_call' && d.name === 'registrar_interes_crm' && d.input?.email) c.senales.add('correo');
      if (f.type === 'interes_internacional' && d.motivo === 'enlace_pago') c.senales.add('enlace_pago');
      if (f.type === 'derivacion_internacional') c.senales.add(d.pago ? 'pago_informado' : 'consulta');
      if (f.type === 'seguimiento' && d.internacional) tot.recordatoriosEnviados++;
      if (f.type === 'seguimiento_respondido') tot.recordatoriosRespondidos++;
      if (f.type === 'seguimiento_omitido' && d.motivo === 'no_es_prospecto') tot.recordatoriosOmitidosNoProspecto++;
      if (f.type === 'bot_en_silencio' && d.motivo === 'sin_contenido') tot.silenciosSinContenido++;
    }
  }
  const lista = [...chats.entries()].filter(([, c]) => c.mensajes.length);
  const porDia: Record<string, number> = {};
  for (const [, c] of lista) porDia[diaEnChile(c.primero)] = (porDia[diaEnChile(c.primero)] ?? 0) + 1;
  const contenido = (c: Chat) => c.mensajes.filter(conContenido).length;
  const resumen = calcularResumen(filas, ahora);
  const conSenal = (s: string) => lista.filter(([, c]) => c.senales.has(s)).length;
  return {
    generado: new Date(ahora).toISOString(),
    desde: lista.length ? new Date(Math.min(...lista.map(([, c]) => c.primero))).toISOString() : null,
    totales: {
      chats: lista.length,
      soloAnuncio: lista.filter(([, c]) => soloMensajeDelAnuncio(c.mensajes)).length,
      conContenido: lista.filter(([, c]) => contenido(c) >= 1).length,
      conversaron: lista.filter(([, c]) => contenido(c) >= 3).length,
      correos: conSenal('correo'),
      enlacesDePago: conSenal('enlace_pago'),
      pagosInformados: conSenal('pago_informado'),
      consultas: conSenal('consulta'),
      consultasAbiertas,
      ...tot,
    },
    chatsPorDia: Object.entries(porDia)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dia, chats]) => ({ dia, chats })),
    ultimas24h: { ...resumen, variantes: undefined },
    pruebaPrimerMensaje: resumen.variantes,
    // Quienes dejaron alguna señal de interés en todo el período, con su negociación.
    conSenales: lista
      .filter(([, c]) => ['correo', 'enlace_pago', 'pago_informado', 'consulta'].some((s) => c.senales.has(s)))
      .map(([id, c]) => ({
        chat: id,
        negociacion: c.deal,
        senales: [...c.senales].filter((s) => !s.startsWith('variante')),
        ultimoMensaje: c.todos.length ? new Date(c.todos[c.todos.length - 1].ts).toISOString() : null,
        ultimos: c.todos.slice(-6).map((t) => ({ hora: new Date(t.ts).toISOString().slice(0, 16), cliente: t.cliente, bot: t.bot })),
      })),
    // Conversaciones con actividad en las últimas 24 h, para leer quién mostró interés.
    conversaciones24h: lista
      .filter(([, c]) => c.turnos.length)
      .map(([id, c]) => ({
        chat: id,
        negociacion: c.deal,
        nuevo: c.primero >= desde24,
        senales: [...c.senales],
        turnos: c.turnos.map((t) => ({ hora: new Date(t.ts).toISOString().slice(0, 16), cliente: t.cliente, bot: t.bot })),
      })),
  };
}

function tokenValido(dado: string): boolean {
  const esperado = process.env.INFORME_INTERNACIONAL_TOKEN ?? '';
  if (esperado.length < 24 || !dado) return false;
  const a = Buffer.from(dado);
  const b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** GET /internacional/informe?token=… */
export async function informeInternacional(req: Request, res: Response): Promise<void> {
  if (!tokenValido(String(req.query.token ?? req.header('x-informe-token') ?? ''))) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const filas = await dbEventosInternacionales(30);
  if (!filas) {
    res.status(503).json({ error: 'sin_base' });
    return;
  }
  const informe = armarInforme(filas, Date.now(), await cuantasConsultasAbiertas().catch(() => 0));
  log.info('informe internacional entregado', { chats: informe.totales.chats });
  res.setHeader('Cache-Control', 'no-store');
  res.json(informe);
}
