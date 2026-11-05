import { config } from '../config';
import { marca } from '../marca';
import { log } from '../log';
import { callBitrix } from '../bitrix/client';
import { getJson, setJson, once } from '../store/kv';
import { conocimientoVigente, type BaseConocimiento } from './conocimientoComercial';
import type { ChannelProfile } from './channel';
import type { Auth } from '../store';

/**
 * Modo internacional: un programa que se ofrece fuera de Latinoamérica por el MISMO número de WhatsApp,
 * sin asesores. El bot responde en el idioma de la persona, informa, registra y entrega el enlace de
 * pago él mismo; cuando no puede resolver algo, avisa al equipo y sigue atendiendo.
 *
 * Por qué un modo aparte y no un programa más del catálogo. En la prueba del 05-11-2026, con el
 * programa cargado como uno más, el bot de Latinoamérica le contestó en español a quien escribía en
 * inglés, y a un interesado que solo dijo "saw your ad" le ofreció la maestría con datos de otra
 * oferta: Coursera incluido, cohorte del 23 de noviembre, beca del 50%. El problema no era el
 * contenido sino lo que el bot tenía a mano. Acá no tiene catálogo, ni planilla de precios, ni base de
 * conocimiento de Latinoamérica: solo la ficha del programa. Lo que el modelo no ve, no lo ofrece.
 *
 * Qué entra:
 * - El contenido: el tema "programa_internacional" de Conocimiento, en el panel. Rige con las reglas
 *   de siempre (validado, con fuente y sin vencer). No vive en el repositorio, que es público.
 * - Quién: el número de la persona empieza con INTERNACIONAL_PREFIJOS (+91), o el mensaje menciona
 *   INTERNACIONAL_PALABRAS (el texto que el anuncio deja escrito). Una vez dentro, la conversación
 *   queda en el modo aunque no lo vuelva a mencionar.
 */

export type FilaFicha = { apartado: string; contenido: string; enlace?: string };

export const TEMA_INTERNACIONAL = 'programa_internacional';
const MARCA_KEY = (dialogId: string) => `internacional:${dialogId}`;
const MARCA_TTL_SEG = 30 * 86400; // lo que dura un traspaso: una conversación de un mes sigue en su modo

const hoyISO = (d: Date) => d.toISOString().slice(0, 10);

/** La ficha de una base de conocimiento, con las reglas de cualquier tema (core/conocimientoComercial.ts):
 *  validada, con fuente, vigente y con al menos una fila completa. Si no, por qué no. */
export function leerFicha(base: BaseConocimiento, hoy: Date = new Date()): { filas: FilaFicha[]; motivo?: undefined } | { filas: null; motivo: string } {
  const def = base.temas?.[TEMA_INTERNACIONAL];
  if (!def) return { filas: null, motivo: 'sin_definicion' };
  if (def.estado !== 'validado') return { filas: null, motivo: 'pendiente_de_validacion' };
  if (!def.fuente) return { filas: null, motivo: 'sin_fuente' };
  if (def.vigenteHasta && def.vigenteHasta < hoyISO(hoy)) return { filas: null, motivo: 'vencido' };
  const filas = (def.entradas ?? [])
    .map((e) => ({
      apartado: String(e.apartado ?? '').trim(),
      contenido: String(e.contenido ?? '').trim(),
      enlace: String(e.enlace ?? '').trim() || undefined,
    }))
    .filter((f) => f.apartado && f.contenido);
  return filas.length ? { filas } : { filas: null, motivo: 'incompleto' };
}

/** La ficha publicada del programa, si se puede usar. */
export function fichaInternacional(hoy: Date = new Date()): FilaFicha[] | null {
  return leerFicha(conocimientoVigente(), hoy).filas;
}

/** Cómo lo ve quien edita el panel, además de las reglas de la ficha: sin países ni palabras
 *  configurados, la ficha puede estar perfecta y nadie llega a ella. */
export function textoVistaInternacional(filas: number): { disponible: boolean; texto: string } {
  if (!modoInternacionalConfigurado()) {
    return {
      disponible: false,
      texto:
        'La ficha está lista, pero todavía no se configuró desde qué países o con qué palabras se entra a este programa. Pídeselo a quien administra el bot.',
    };
  }
  const quien = [
    config.internacionalPrefijos.length ? `escribe desde ${config.internacionalPrefijos.join(', ')}` : '',
    config.internacionalPalabras.length ? `menciona ${config.internacionalPalabras.map((p) => `«${p}»`).join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(' o ');
  return { disponible: true, texto: `El bot usa ${filas === 1 ? '1 fila' : `${filas} filas`} con quien ${quien}, y le responde en su idioma.` };
}

/** ¿Hay forma de entrar al modo? Sin prefijos ni palabras configurados, no existe. */
export function modoInternacionalConfigurado(): boolean {
  return config.internacionalPrefijos.length > 0 || config.internacionalPalabras.length > 0;
}

/**
 * ¿El número es de uno de los países del modo? Se exige el número completo, con código de país (11
 * dígitos o más): un celular chileno sin el 56 empieza con 9 y tiene 9 dígitos, y "912345678" no
 * puede pasar por un número de India.
 */
export function esTelefonoInternacional(telefono: string | null | undefined, prefijos: string[] = config.internacionalPrefijos): boolean {
  const digitos = String(telefono ?? '').replace(/\D/g, '');
  if (digitos.length < 11) return false;
  return prefijos.some((p) => digitos.startsWith(p.slice(1)));
}

const plano = (s: string) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
const soloLetras = (s: string) => plano(s).replace(/[^a-z0-9]/g, '');

/** ¿El texto menciona alguna de las palabras del modo? "Demo@Pro", "demo @ pro" y "Demo Pro" cuentan igual. */
export function mencionaPalabraInternacional(texto: string, palabras: string[] = config.internacionalPalabras): boolean {
  const t = plano(texto);
  const tLetras = soloLetras(texto);
  return palabras.some((p) => {
    if (t.includes(plano(p))) return true;
    // Sin signos solo si queda algo distintivo: con "ai" a secas coincidiría media conversación.
    const letras = soloLetras(p);
    return letras.length >= 5 && tLetras.includes(letras);
  });
}

/**
 * La ficha, si esta conversación va por el modo internacional; null si no. Se decide con el número y
 * con lo que escribió, y se recuerda: quien entró por el anuncio no tiene por qué repetir el nombre
 * del programa. Con la ficha desactivada en el panel, nadie entra y el bot atiende como siempre.
 */
export async function fichaSiEsInternacional(a: {
  dialogId: string;
  telefono: () => Promise<string | null>;
  textos: string[];
}): Promise<FilaFicha[] | null> {
  if (!modoInternacionalConfigurado()) return null;
  const ficha = fichaInternacional();
  if (!ficha) return null;
  if (await getJson(MARCA_KEY(a.dialogId))) return ficha;
  const motivo = a.textos.some((t) => mencionaPalabraInternacional(t))
    ? 'palabra'
    : esTelefonoInternacional(await a.telefono())
      ? 'telefono'
      : null;
  if (!motivo) return null;
  await setJson(MARCA_KEY(a.dialogId), { motivo, at: Date.now() }, MARCA_TTL_SEG);
  log.info('internacional: la conversación entra al modo internacional', { dialogId: a.dialogId, motivo });
  return ficha;
}

/** Los enlaces de la ficha: los únicos que el bot puede compartir en este modo (ver aplicarGuardian). */
export function urlsDeLaFicha(ficha: FilaFicha[]): string[] {
  return ficha.map((f) => f.enlace).filter((u): u is string => Boolean(u));
}

function textoFicha(ficha: FilaFicha[]): string {
  return ficha.map((f) => `- ${f.apartado}: ${f.contenido}${f.enlace ? `\n  Link: ${f.enlace}` : ''}`).join('\n');
}

/**
 * Las instrucciones del modo, en inglés. Con el prompt de Latinoamérica —en español, "responde SIEMPRE
 * en español", hablar como el asesor— el modelo volvía al español aunque se le pidiera otro idioma.
 */
export function promptInternacional(ficha: FilaFicha[]): string {
  const org = marca.organizacion;
  return `You are the admissions assistant of ${org} for the programme described below. You chat on WhatsApp with people interested in it; most of them write from India after seeing an ad. This programme has NO human advisors: you answer, guide the enrolment and share the payment link yourself.

LANGUAGE (strict): reply in the language and script the person uses. English by default. If they write in Devanagari, reply in Hindi in Devanagari. If they write Hindi with Latin letters (Hinglish), reply in Hinglish. If they write in Spanish, reply in Spanish. Keep the programme name, technical terms and amounts as they are. Always use the respectful form: "aap" and its verb forms ("kariye", "bataiye", never "karo" or "tum") in Hindi and Hinglish, "usted" in Spanish.

WHO YOU ARE: if they ask, you are ${org}'s virtual admissions assistant. Never claim to be a person and never invent a name. Don't volunteer that there are no advisors: if they ask for a call or a person, say you can help them with everything right here; only if they insist, use escalar_a_humano.

THE ONLY SOURCE (strict): everything you say about the programme, its price, payment, dates, requirements, certificate or recognition must come from PROGRAMME FACTS. That includes payment methods: whether UPI, cards, bank transfers or a given currency are accepted. If something is not there, say you don't have that detail, call escalar_a_humano so the admissions team checks it, and don't guess.

TOOLS AND TEXT (strict): call the tools you need first, and write your whole reply in your final message, after their results. Text you write in the same message as a tool call never reaches the person: a payment link written there is lost. Never mention other programmes of ${org}, scholarships, discounts or amounts in local currency unless PROGRAMME FACTS includes them. Never promise jobs, promotions, salary increases or any recognition that PROGRAMME FACTS doesn't state. Respect every "never say" rule in PROGRAMME FACTS.

HOW TO HELP THEM ENROL:
1. Answer what they asked in a few short sentences, then ask ONE question that moves things forward.
2. Learn what they do and whether they code, so you can recommend the right track if the programme has tracks.
3. Ask for their name and then their email, one at a time, only when they want to enrol or ask you to send or save something, and never in two messages in a row: until then, keep answering and ask about their work or goals instead. Save each one with registrar_interes_crm as soon as they give it, always with programa_interes set to the programme name. You already have their phone number: don't ask for it.
4. When they want to enrol or pay, share the payment option they choose with its link from PROGRAMME FACTS, exactly as written, on its own line, together with the price and the taxes note. Ask them to write here once they have paid. If PROGRAMME FACTS has no link for the option they chose, call escalar_a_humano with motivo "Enviar enlace de pago" plus the option, their name and email, and tell them the admissions team will send the payment link here or by email: without that call nobody sends it.
5. When they say they have paid, thank them, call escalar_a_humano with motivo "Pago informado" and the details they gave, and tell them the admissions team will confirm the payment and send their access by email.
6. If they hesitate, ask what is holding them back and answer with facts. Never pressure, never invent urgency or deadlines.

LINKS: share only links that appear in PROGRAMME FACTS, exactly as written. Never write any other link.

WHEN YOU CAN'T SOLVE IT (a complaint, a refund, a payment problem, a legal or special case, or they insist on talking to a person): call escalar_a_humano with a short summary in Spanish, and tell them the admissions team will review it and reply here or by email. Don't promise a time, and keep helping with anything you can answer.

STYLE: WhatsApp messages: short (under 500 characters), warm and professional, no headings, no bold, at most one emoji. One question per message.

PROGRAMME FACTS:
${textoFicha(ficha)}`;
}

/** El perfil del turno en modo internacional: mismo canal y modelo, otras instrucciones y otras herramientas. */
export function perfilInternacional(base: ChannelProfile, ficha: FilaFicha[]): ChannelProfile {
  return {
    ...base,
    label: `${base.label} · internacional`,
    systemPrompt: promptInternacional(ficha),
    // Sin catálogo, precios ni conocimiento de Latinoamérica: el programa entero viaja en el prompt.
    toolNames: ['registrar_interes_crm', 'escalar_a_humano'],
    respondeEnIdiomaDelCliente: true,
    descripcionesDeTools: {
      // La de siempre dice "úsala si hay intención alta de matrícula": acá eso es mandar el enlace de pago.
      escalar_a_humano:
        'Notifies the admissions team. There are no advisors: the chat stays with you and you keep helping. Use it ONLY ' +
        'when the person says they have paid (motivo "Pago informado"), for a complaint, a refund, a payment problem, ' +
        'a legal or special case, a question that PROGRAMME FACTS does not answer, or if they insist on talking to a ' +
        'person. Never use it because they want to enrol: share the payment link instead. Write motivo in Spanish.',
    },
  };
}

/** A quiénes avisar en este modo. */
export function destinatariosInternacional(): number[] {
  const lista = config.internacionalAvisarA.length ? config.internacionalAvisarA : [config.derivacionSupervisorId];
  return [...new Set(lista.filter((n) => n > 0))];
}

/**
 * Aviso interno al equipo (notificación de Bitrix con el enlace al chat). No saca al bot de la
 * conversación: no hay asesores a quienes entregarla. `clave` evita repetir el mismo aviso.
 */
export async function avisarEquipoInternacional(
  a: { dialogId: string; titulo: string; detalle: string; clave?: string; ttlSeg?: number },
  auth: Auth,
): Promise<number> {
  const destinos = destinatariosInternacional();
  if (!destinos.length) {
    log.warn('internacional: no hay a quién avisar (INTERNACIONAL_AVISAR_A ni BITRIX_SUPERVISOR_ID)', { dialogId: a.dialogId });
    return 0;
  }
  if (a.clave && !(await once(`internacional:aviso:${a.dialogId}:${a.clave}`, a.ttlSeg ?? 24 * 3600))) return 0;
  const texto = [
    `[B]${a.titulo}[/B]`,
    a.detalle,
    auth.domain ? `[URL=https://${auth.domain}/online/?IM_DIALOG=${a.dialogId}]Abrir el chat[/URL]` : '',
  ]
    .filter(Boolean)
    .join('\n');
  let enviados = 0;
  for (const userId of destinos) {
    try {
      await callBitrix('im.notify.personal.add', { USER_ID: userId, MESSAGE: texto }, auth);
      enviados++;
    } catch (e) {
      log.warn('internacional: no se pudo avisar al equipo', { dialogId: a.dialogId, userId, err: String(e) });
    }
  }
  return enviados;
}
