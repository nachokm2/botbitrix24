import { getRedisClient, once } from '../store/kv';
import { audit } from '../obs/audit';
import { log } from '../log';

/**
 * Lista de exclusión: a quién NO se le vuelve a escribir nunca.
 *
 * Responder a quien te escribe no necesita permiso; escribir primero, sí — y la contrapartida de
 * poder escribir primero es respetar al que dice que no. Sin esto, el primer contacto sería una
 * campaña sin salida: la persona pide que no le escriban, nadie lo registra, y el mes siguiente
 * vuelve a recibir un mensaje.
 *
 * Importa además por un motivo práctico: quien no puede salir, bloquea o reporta. Eso degrada la
 * calificación del número en Meta, que es el MISMO por el que el bot conversa con todos los demás.
 *
 * La baja se guarda por teléfono (normalizado) y por contacto, porque la misma persona puede
 * aparecer con varias fichas en el CRM.
 */

const CLAVE_TEL = (telefono: string) => `exclusion:tel:${telefono}`;
const CLAVE_CONTACTO = (contactId: number) => `exclusion:contacto:${contactId}`;
const PARA_SIEMPRE = 10 * 365 * 24 * 3600; // una baja no caduca; el TTL solo evita basura eterna

/**
 * Frases con las que la gente pide que no le escriban más. Se exige que sea una petición explícita:
 * un "no" suelto o un "no me interesa este programa" NO es una baja — es parte de la conversación,
 * y tratarlo como baja haría perder leads que solo estaban descartando una opción.
 */
const FRASES_BAJA = [
  /\bno (me )?(vuelvan? a |vuelvas? a )?(escrib|contact|molest|llam)/,
  /\bno quiero (que me )?(escrib|contact|llam|recib)/,
  /\bd(a|e)(r|)me de baja\b/,
  /\bdesuscrib/,
  /\bquit(a|e)nme de (la lista|sus listas|esta lista)/,
  /\bborr(a|e)nme de (la lista|sus listas)/,
  /\bbaja de la lista\b/,
  /\bstop\b/,
  /\bunsubscribe\b/,
  /\bno insistan?\b/,
  // También en singular: «Amigo porfa deje de molestar» no calzaba y siguieron los recordatorios
  // (chat 1593997, 09-11-2026).
  /\bdej(a|e|en) de (escrib|molest|mandar|enviar|insistir)/,
  // El botón de baja de las plantillas de Meta: después de «Detener promociones» salieron cinco
  // recordatorios (chat 1596719, 10-11-2026).
  /\b(detener|parar|cancelar|suspender) (las |los |estas |estos )?(promociones|mensajes|envios|notificaciones)\b/,
  /\b(los|las|lo|la|te|les)? ?voy a denunciar/,
  /\bdenunciar(los|las|lo|la|te)\b/,
  // «Voy a bloquearlos»: después de eso salieron cinco recordatorios más (chat 1577067, 06-11-2026).
  /\b(los|las|lo|la|te|les)? ?voy a bloquear/,
  /\bbloquear(los|las|lo|la|te)\b/,
  /\b(los|las|lo|la|te) (bloqueo|bloqueare|voy a reportar)\b/,
  /\b(es|esto es|son) spam\b/,
  /\breportar(los|lo|las)? (como|por) spam\b/,
  /\b(eliminen|borren|saquen) mi (numero|contacto|dato)/,
];

const norm = (s: string) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** ¿El mensaje es una petición explícita de no volver a escribir? */
export function pideNoMolestar(mensaje: string): boolean {
  const t = norm(mensaje);
  if (!t || t.length > 300) return false; // un texto largo rara vez es una baja; evita falsos positivos
  return FRASES_BAJA.some((re) => re.test(t));
}

/**
 * ¿La respuesta del bot le promete a la persona que no le va a escribir más? Entonces hay que cumplirlo,
 * aunque su mensaje no calzara con ninguna frase de baja: en el chat 1593997 (09 al 12-11-2026) el bot
 * contestó nueve veces «no le escribo más» a insultos y amenazas de denuncia, y los recordatorios
 * siguieron saliendo. Se exige «más» o «volver a»: «no le escribo por WhatsApp» no es una promesa.
 */
const PROMESAS_DE_NO_ESCRIBIR = [
  /\bno (le |lo |la |te |les |los |las )?(escribo|escribimos|escribire|escribiremos|molesto|molestamos|molestare|contacto|contactamos) mas\b/,
  /\bno (le |lo |la |te |les |los |las )?(vuelvo|volvemos|volvere|volveremos) a (escribir|contactar|molestar)/,
  /\bno (le |les |te )?(lleguen|llegaran|llegara|van a llegar) mas (mensajes|promociones|recordatorios)/,
];

export function prometioNoEscribir(respuesta: string): boolean {
  const t = norm(respuesta);
  return Boolean(t) && PROMESAS_DE_NO_ESCRIBIR.some((re) => re.test(t));
}

/** Registra la baja. Idempotente: repetirla no vuelve a auditar. */
export async function excluir(opts: { telefono?: string; contactId?: number; motivo: string; dialogId?: string }): Promise<void> {
  const r = getRedisClient();
  if (!r) return log.warn('exclusión: sin Redis, la baja NO queda registrada', { motivo: opts.motivo });
  try {
    if (opts.telefono) await r.set(CLAVE_TEL(opts.telefono), opts.motivo, 'EX', PARA_SIEMPRE);
    if (opts.contactId) await r.set(CLAVE_CONTACTO(opts.contactId), opts.motivo, 'EX', PARA_SIEMPRE);
    const clave = opts.telefono ?? String(opts.contactId ?? '');
    if (await once(`exclusion:audit:${clave}`, PARA_SIEMPRE)) {
      await audit({
        type: 'exclusion',
        dialogId: opts.dialogId,
        crmEntity: opts.contactId ? `contact#${opts.contactId}` : undefined,
        detail: { motivo: opts.motivo },
      });
    }
    log.info('exclusión registrada', { motivo: opts.motivo, contactId: opts.contactId });
  } catch (e) {
    log.warn('excluir falló', { err: String(e) });
  }
}

/** ¿Esta persona pidió que no le escribamos? Ante la duda (sin Redis) responde que SÍ: es más barato
 *  no escribirle a alguien que escribirle a quien pidió que no. */
export async function estaExcluido(opts: { telefono?: string; contactId?: number }): Promise<boolean> {
  const r = getRedisClient();
  if (!r) return true;
  try {
    if (opts.telefono && (await r.get(CLAVE_TEL(opts.telefono)))) return true;
    if (opts.contactId && (await r.get(CLAVE_CONTACTO(opts.contactId)))) return true;
    return false;
  } catch (e) {
    log.warn('estaExcluido falló', { err: String(e) });
    return true;
  }
}
