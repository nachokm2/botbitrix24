import crypto from 'node:crypto';
import { anthropic, CLASSIFIER } from '../ai/client';
import { recordTokens } from '../obs/metrics';
import { getJson, setJson } from '../store/kv';
import { config } from '../config';
import { log } from '../log';
import { modoInternacionalConfigurado } from './internacional';
import type { FilaAuditoria } from '../store/db';

/**
 * Las conversaciones del modo internacional (core/internacional.ts), para leerlas en español en el panel
 * (sección «Conversaciones India», routes/panelInternacional.ts). Pedido del usuario del 14-11-2026: el
 * bot atiende en inglés o hindi a quienes llegan por el anuncio de India, y él e Ignacio necesitan saber
 * qué les dice.
 *
 * Se arma con la auditoría que ya existe: los turnos marcados como internacionales, el correo que el
 * bot registró, sus pedidos de ayuda al equipo y la negociación que creó. Nada de esto toca al bot.
 */

/** Solo ellos ven la sección (config.panelConversacionesInternacionales). */
export function puedeVerConversacionesInternacionales(usuarioId: number): boolean {
  return config.panelConversacionesInternacionales.includes(usuarioId);
}

/** ¿Quien entró al panel ve la sección? Además de estar en la lista, el modo tiene que existir. */
export function seccionInternacionalVisible(usuarioId: number): boolean {
  return modoInternacionalConfigurado() && puedeVerConversacionesInternacionales(usuarioId);
}

export type Turno = { ts: string; cliente: string; bot: string };
export type Evento = { ts: string; tipo: 'negociacion' | 'correo' | 'ayuda' | 'pago'; texto: string };
export type ConversacionInternacional = {
  dialogId: string;
  inicio: string;
  fin: string;
  dealId: number | null;
  turnos: Turno[];
  eventos: Evento[];
  dejoCorreo: boolean;
  pidioAyuda: boolean;
  informoPago: boolean;
};

const iso = (ts: string | Date) => new Date(ts).toISOString();

/** Un enlace de Bitrix ("[URL=…]Open[/URL]", como llegan los audios) se muestra como «[adjunto]». */
export function limpiarTexto(t: unknown): string {
  return String(t ?? '')
    .replace(/\[URL=[^\]]*\][^[]*\[\/URL\]/gi, '[adjunto]')
    .trim();
}

/** Agrupa las filas de la auditoría por conversación, de la más reciente a la más antigua. Solo cuentan
 *  los turnos del modo internacional: si la conversación tuvo antes turnos de Latinoamérica, no se muestran. */
export function armarConversaciones(filas: FilaAuditoria[]): ConversacionInternacional[] {
  const chats = new Map<string, ConversacionInternacional>();
  for (const f of filas) {
    const d = f.detail ?? {};
    let c = chats.get(f.dialog_id);
    if (!c) {
      c = { dialogId: f.dialog_id, inicio: '', fin: '', dealId: null, turnos: [], eventos: [], dejoCorreo: false, pidioAyuda: false, informoPago: false };
      chats.set(f.dialog_id, c);
    }
    const ts = iso(f.ts);
    const deal = /^deal#(\d+)$/.exec(String(f.crm_entity ?? ''));
    if (deal && !c.dealId) c.dealId = Number(deal[1]);
    if (f.type === 'turn') {
      if (!d.internacional) continue;
      c.turnos.push({ ts, cliente: limpiarTexto(d.message), bot: limpiarTexto(d.reply) });
      if (!c.inicio) c.inicio = ts;
      c.fin = ts;
    } else if (f.type === 'negociacion_internacional') {
      if (deal) c.dealId = Number(deal[1]);
      c.eventos.push({ ts, tipo: 'negociacion', texto: `Se creó la negociación${deal ? ` #${deal[1]}` : ''} en Bitrix.` });
    } else if (f.type === 'derivacion_internacional') {
      const pago = Boolean(d.pago);
      if (pago) c.informoPago = true;
      else c.pidioAyuda = true;
      c.eventos.push({ ts, tipo: pago ? 'pago' : 'ayuda', texto: `El bot avisó al equipo: ${String(d.motivo ?? 'sin detalle')}` });
    } else if (f.type === 'tool_call' && d.name === 'registrar_interes_crm' && d.ok !== false && d.input?.email) {
      if (!c.dejoCorreo) c.eventos.push({ ts, tipo: 'correo', texto: 'Dejó su correo y quedó registrado en el CRM.' });
      c.dejoCorreo = true;
    }
  }
  return [...chats.values()].filter((c) => c.turnos.length).sort((a, b) => b.fin.localeCompare(a.fin));
}

/** ¿Ya está en español? Por su ortografía, como pareceEspanol de ai/agentLoop.ts, sin el hindi. */
function yaEnEspanol(t: string): boolean {
  return /[¿¡ñáéíóú]/i.test(t) && !/[ऀ-ॿ]/.test(t);
}

const TRADUCCION_KEY = (t: string) => `traduccion:es:${crypto.createHash('sha1').update(t).digest('hex')}`;
const TRADUCCION_TTL_SEG = 180 * 86400;

/**
 * El texto en español neutro. Cada texto se traduce una sola vez y queda guardado, así que abrir el panel
 * no vuelve a gastar. Si la traducción falla, devuelve null y el panel muestra el original.
 */
export async function traducirAlEspanol(texto: string): Promise<string | null> {
  const t = texto.trim();
  if (!t) return '';
  if (yaEnEspanol(t)) return t;
  const guardada = await getJson<string>(TRADUCCION_KEY(t)).catch(() => null);
  if (guardada) return guardada;
  try {
    const resp = await anthropic.messages.create({
      model: CLASSIFIER,
      max_tokens: 1200,
      temperature: 0,
      system:
        'Traduce al español neutro latinoamericano un mensaje de WhatsApp entre una persona interesada en un curso y el ' +
        'asistente de admisiones de una universidad. Puede venir en inglés, en hindi o en hinglish. Conserva tal cual los ' +
        'enlaces, los montos, los correos, los nombres propios y el nombre del programa, y los emojis. Devuelve SOLO la ' +
        'traducción, sin comillas ni explicaciones.',
      messages: [{ role: 'user', content: t }],
    });
    recordTokens((resp as any).usage);
    const es = (resp.content as any[])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    if (!es) return null;
    await setJson(TRADUCCION_KEY(t), es, TRADUCCION_TTL_SEG).catch(() => {});
    return es;
  } catch (e) {
    log.warn('conversaciones internacionales: no se pudo traducir', { err: String(e) });
    return null;
  }
}

/** Traduce varios textos, de a pocos a la vez. */
export async function traducirVarios(textos: string[], simultaneos = 4): Promise<Array<string | null>> {
  const out: Array<string | null> = new Array(textos.length).fill(null);
  let siguiente = 0;
  const trabajador = async () => {
    while (siguiente < textos.length) {
      const i = siguiente++;
      out[i] = await traducirAlEspanol(textos[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(simultaneos, textos.length) }, trabajador));
  return out;
}
