import { callBitrix } from '../bitrix/client';
import { config } from '../config';
import { once } from '../store/kv';
import type { Auth } from '../store';
import type { Traspaso } from '../session';
import { conectorDelChat } from '../core/listaBlanca';
import { derivacionYaGestionada } from '../crm/embudos';
import { entidadesDelSeguimiento } from './seguimiento';
import { audit } from '../obs/audit';
import { log } from '../log';
import type { EstadoChat } from './retomarChat';

/**
 * Avisa cuando un cliente espera a una persona del equipo y nadie le responde.
 *
 * Con una persona dentro del chat, el bot no puede retomarlo: Bitrix rechaza traspasarle la sesión a
 * un bot ("imopenlines.operator.transfer: OPERATOR_WRONG You can not redirect to this operator", en
 * todos los intentos del 03 al 05-11-2026). Mientras el bot reintentaba, cuatro clientes de Carver
 * pasaron más de 20 h sin respuesta: tres en chats que el bot había derivado y uno en un chat tomado
 * por una asesora. Lo que sirve es que se entere alguien que pueda contestar:
 *   1. A las AVISO_ESPERA_HORAS, las personas del chat y la supervisora (BITRIX_SUPERVISOR_ID).
 *   2. A las AVISO_ESPERA_ESCALAR_HORAS del último mensaje del cliente, AVISO_ESPERA_USUARIOS (o quienes
 *      reciben el control diario): quedan pocas horas de la ventana de 24 h de WhatsApp.
 * Cada aviso sale una vez por espera. Un "gracias" o un "ya no estoy interesado/a" no es una espera.
 */

/** WhatsApp solo deja responder libremente dentro de las 24 h del último mensaje del cliente. Se
 *  deja una hora de margen. */
export const VENTANA_WHATSAPP_MS = 23 * 3600_000;
const VENTANA_REAL_MS = 24 * 3600_000;
const AVISO_TTL_SEG = 3 * 24 * 3600;

/** Traspasos que hizo el bot (escalar_a_humano o por puntaje). Si un asesor entró al chat por su
 *  cuenta, el traspaso queda como 'operador'; si era horario de asesores, como 'horario_asesores'. */
export const DERIVACIONES_DEL_BOT = new Set(['escalado', 'auto_escalado']);

/** Lo que escribió el cliente. Al tocar un botón de una plantilla, el conector de WhatsApp copia la
 *  plantilla entera entre dos líneas de guiones y deja debajo el botón que tocó. */
export function textoDelCliente(texto: string): string {
  const partes = String(texto ?? '').split(/^-{20,}[ \t]*$/m);
  return partes[partes.length - 1].trim();
}

/** El conector devuelve al chat, a nombre del cliente, el archivo que le mandó el bot: «[B]Sent from
 *  external application[/B] … Brochure — Licenciatura en Psicología». No lo escribió el cliente. */
export const esEcoDeEnvio = (texto: string) => /^\s*\[B\]Sent from external application\[\/B\]/i.test(String(texto ?? ''));

const normalizar = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9?]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// "Gracias Claudio!!", "Perfecto, muchas gracias", "Por el momento es todo gracias", "Saludos". No
// incluye "buenas noches": también abre una conversación.
const CORTESIA =
  /^(?:(?:ok|okay|oki|vale|listo|perfecto|genial|excelente|entendido|dale|bueno|super|muy bien) )*(?:(?:muchas|mil|muchisimas) )?gracias\b|^(?:por (?:el momento|ahora) )?(?:eso )?(?:es|seria) todo\b|^(?:de nada|igualmente|saludos|bendiciones|chao|adios|hasta (?:luego|pronto|manana))\b/;
// "Ya no estoy interesado/a" (botón de la plantilla de cierre), "O sea no me interesa", "No gracias".
const RECHAZO = /\b(?:no me interesa|(?:ya )?no estoy interesad|no gracias|no quiero (?:seguir|continuar)|no me (?:escriban|escriba|contacten|contacte))/;
// Lo que convierte un "gracias" en un pedido: muchos preguntan sin signo de interrogación.
const PEDIDO = /\b(?:pero|quisiera|quiero|queria|necesito|puede|podria|podrias|envie|enviar|mande|mandar|cuando|cuanto|como|donde|cual|enlace|link)\b/;
const MENSAJE_CORTO = 80;

/** ¿Este mensaje del cliente pide una respuesta? Un agradecimiento, una despedida o un "no me
 *  interesa" no dejan nada que contestar. Ante la duda, sí: un aviso de más cuesta menos que un
 *  cliente sin respuesta. */
export function esperaRespuesta(texto: string): boolean {
  const t = normalizar(textoDelCliente(texto));
  if (t.includes('?')) return true;
  if (!t) return false; // un emoji o un sticker
  if (t.length > MENSAJE_CORTO) return true;
  if (PEDIDO.test(t)) return true;
  return !(RECHAZO.test(t) || CORTESIA.test(t));
}

export type Espera = {
  /** Desde cuándo espera (ms): su primer mensaje sin responder, o la derivación. */
  desde: number;
  motivo: 'cliente_escribio' | 'derivacion_sin_tomar';
  /** Su último mensaje sin responder, para el aviso. */
  ultimoMensaje: string | null;
};

/**
 * ¿El cliente espera a una persona del equipo? PURO.
 * - Escribió algo que pide respuesta y nadie le contestó, ni el bot ni el equipo.
 * - O el bot le derivó el chat a una persona y nadie del equipo le escribió después. El bot le dijo
 *   que lo confirmaba y le respondía, y el cliente se despidió con un "gracias" (chat 1192249: pidió la
 *   resolución de SENESCYT, el bot prometió responder "hoy mismo" y nadie lo hizo).
 */
export function esperaDelCliente(e: EstadoChat, t: Pick<Traspaso, 'at' | 'motivo'> | null): Espera | null {
  const reales = e.pendientesConFecha.filter((p) => esperaRespuesta(p.texto));
  if (reales.length) return { desde: reales[0].at, motivo: 'cliente_escribio', ultimoMensaje: reales[reales.length - 1].texto };
  if (t && DERIVACIONES_DEL_BOT.has(t.motivo) && e.ultimaDelEquipo < t.at) return { desde: t.at, motivo: 'derivacion_sin_tomar', ultimoMensaje: null };
  return null;
}

export type Nivel = 1 | 2;

/** Qué avisos tocan ahora, salgan o no por primera vez. PURO. Solo dentro de la ventana de 24 h:
 *  después ya no se le puede escribir libremente y el aviso llega tarde. */
export function avisosDebidos(
  espera: Espera,
  ultimaDelCliente: number,
  horas: { primero: number; escalar: number },
  ahora = Date.now(),
): Nivel[] {
  if (horas.primero <= 0 || !ultimaDelCliente || ahora - ultimaDelCliente > VENTANA_WHATSAPP_MS) return [];
  if (ahora - espera.desde < horas.primero * 3600_000) return [];
  return horas.escalar > 0 && ahora - ultimaDelCliente >= horas.escalar * 3600_000 ? [1, 2] : [1];
}

export type DatosAviso = {
  dominio: string;
  dialogId: string;
  /** Nombre del cliente en el chat, si lo hay. */
  cliente: string | null;
  /** Nombres de las personas del equipo que están en el chat. */
  aCargo: string[];
  espera: Espera;
  ultimaDelCliente: number;
  /** Si es WhatsApp, el aviso dice hasta cuándo se le puede escribir. */
  whatsapp: boolean;
  ahora: number;
};

const FECHA_CHILE = new Intl.DateTimeFormat('es-CL', {
  timeZone: 'America/Santiago',
  weekday: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

// Sin BB-code: lo que escribió el cliente no debe poder meter enlaces en la notificación.
const extracto = (s: string | null) => {
  const t = textoDelCliente(s ?? '').replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
  return t.length > 160 ? `${t.slice(0, 157)}…` : t;
};

/** El texto de la notificación de Bitrix. PURO. */
export function textoDelAviso(nivel: Nivel, d: DatosAviso): string {
  const horas = Math.max(1, Math.round((d.ahora - d.espera.desde) / 3600_000));
  const cierre = d.ultimaDelCliente + VENTANA_REAL_MS;
  const quedan = Math.max(1, Math.round((cierre - d.ahora) / 3600_000));
  const derivado = d.espera.motivo === 'derivacion_sin_tomar';
  const titulo =
    nivel === 2
      ? `Cliente sin respuesta hace ${horas} h${d.whatsapp ? `: la ventana de WhatsApp cierra en ${quedan} h` : ''}`
      : derivado
        ? `Chat derivado sin respuesta hace ${horas} h`
        : `Cliente esperando respuesta hace ${horas} h`;
  const cuerpo = derivado
    ? `El asistente derivó este chat hace ${horas} h y nadie del equipo le ha escrito ${d.cliente ? `a ${d.cliente}` : 'al cliente'} desde entonces.`
    : `${d.cliente ?? 'El cliente'} escribió en el chat y nadie le ha respondido: «${extracto(d.espera.ultimoMensaje)}».`;
  return [
    `[B]${titulo}[/B]`,
    cuerpo,
    d.aCargo.length ? `En el chat: ${d.aCargo.join(', ')}.` : '',
    d.whatsapp ? `WhatsApp deja escribirle libremente hasta el ${FECHA_CHILE.format(new Date(cierre))} (hora de Chile); después, solo con una plantilla.` : '',
    `[URL=https://${d.dominio}/online/?IM_DIALOG=${d.dialogId}]Abrir el chat[/URL]`,
  ]
    .filter(Boolean)
    .join('\n');
}

type Participante = { id?: number | string; name?: string };

/**
 * Manda los avisos que correspondan a un chat con una persona del equipo dentro. Devuelve los niveles
 * enviados, o los que se enviarían con `simular`. `auth` lee el chat y el CRM; `authAvisos` firma las
 * notificaciones, igual que los demás avisos internos.
 */
export async function avisarSiEspera(p: {
  dialogId: string;
  chatId: string;
  estado: EstadoChat;
  traspaso: Traspaso | null;
  participantes: Participante[];
  auth: Auth;
  authAvisos: Auth;
  simular?: boolean;
  ahora?: number;
}): Promise<Nivel[]> {
  if (config.avisoEsperaHoras <= 0) return [];
  const ahora = p.ahora ?? Date.now();
  const espera = esperaDelCliente(p.estado, p.traspaso);
  if (!espera) return [];
  const debidos = avisosDebidos(espera, p.estado.ultimaDelCliente, { primero: config.avisoEsperaHoras, escalar: config.avisoEsperaEscalarHoras }, ahora);
  if (!debidos.length) return [];
  // Un asesor que movió la negociación después de la derivación la trabaja por fuera del chat (una
  // llamada, un correo): eso no es un chat abandonado.
  if (espera.motivo === 'derivacion_sin_tomar') {
    const entidades = await entidadesDelSeguimiento(p.dialogId);
    if (entidades?.deal && (await derivacionYaGestionada(entidades.deal, p.auth))) return [];
  }
  if (p.simular) return debidos;

  const nombre = (id: string | null) => (id ? p.participantes.find((u) => String(u.id) === id)?.name?.trim() || null : null);
  const personas = p.estado.equipo
    .map(Number)
    .filter((id) => id > 0 && !config.usuariosAutomaticos.includes(id) && !config.usuariosBot.includes(id));
  const datos: DatosAviso = {
    dominio: p.authAvisos.domain,
    dialogId: p.dialogId,
    cliente: nombre(p.estado.clienteId),
    aCargo: personas.map((id) => nombre(String(id))).filter((n): n is string => Boolean(n)),
    espera,
    ultimaDelCliente: p.estado.ultimaDelCliente,
    whatsapp: /whats/i.test((await conectorDelChat(p.chatId, p.auth)) ?? ''),
    ahora,
  };
  const escalarA = config.avisoEsperaUsuarios.length ? config.avisoEsperaUsuarios : config.controlDiarioDestinatarios;
  const horas = Math.round((ahora - espera.desde) / 3600_000);

  const enviados: Nivel[] = [];
  for (const nivel of debidos) {
    const destinos = [...new Set(nivel === 1 ? [...personas, config.derivacionSupervisorId] : escalarA)].filter((id) => id > 0);
    if (!destinos.length) continue;
    // Se reclama el aviso antes de mandarlo: lo envía una sola instancia, y si Bitrix falla no se
    // insiste (perder un aviso es preferible a repetírselo a alguien cada 10 minutos).
    if (!(await once(`aviso_espera:${p.dialogId}:${nivel}:${espera.desde}`, AVISO_TTL_SEG))) continue;
    const texto = textoDelAviso(nivel, datos);
    for (const userId of destinos) {
      await callBitrix('im.notify.personal.add', { USER_ID: userId, MESSAGE: texto }, p.authAvisos).catch((e) =>
        log.warn('avisoEspera: no se pudo notificar', { dialogId: p.dialogId, userId, err: String(e) }),
      );
    }
    enviados.push(nivel);
    void audit({ type: 'aviso_cliente_esperando', dialogId: p.dialogId, detail: { nivel, motivo: espera.motivo, horas, avisadoA: destinos } }).catch(() => {});
    log.info('avisoEspera: aviso enviado', { dialogId: p.dialogId, nivel, motivo: espera.motivo, horas, avisadoA: destinos });
  }
  return enviados;
}
