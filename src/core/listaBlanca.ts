import { callBitrix } from '../bitrix/client';
import { config } from '../config';
import { log } from '../log';
import type { Auth } from '../store';

/**
 * Modo prueba: el bot solo le responde a los números de una lista.
 *
 * Sirve para probar en vivo sin arriesgar conversaciones reales. Apagar el bot entero no deja
 * probar nada, y dejarlo abierto significa que cualquier lead que escriba se lleva una versión que
 * todavía se está ajustando.
 *
 * Con la lista vacía —que es lo normal— no hace nada y el bot atiende a todos.
 *
 * Fail-CLOSED a propósito, al revés que casi todo lo demás del proyecto: si no se puede averiguar
 * de qué número viene el chat, el bot NO responde. En modo prueba, un silencio de más es gratis;
 * una respuesta de más va a un cliente real que no debía recibirla.
 */

const CACHE_MS = 10 * 60_000;
/** Datos que trae el identificador del chat de Open Lines: conector | LÍNEA | teléfono | user
 *  (ej. "ank_chats_app24_ca_whats_app|31|56923883848|805047"). Se cachea el parseo completo para no
 *  consultar a Bitrix una vez por mensaje; lo usan la lista blanca (teléfono) y la compuerta de líneas
 *  (routes/botEvents.ts). */
type EntidadChat = { connector: string | null; linea: string | null; telefono: string | null };
const cache = new Map<string, { datos: EntidadChat; hasta: number }>();
const VACIO: EntidadChat = { connector: null, linea: null, telefono: null };

/** Solo dígitos, para comparar "+56 9 2388 3848" con "56923883848". */
const soloDigitos = (s: string) => String(s ?? '').replace(/\D/g, '');

export function listaBlancaActiva(): boolean {
  return config.soloEstosNumeros.length > 0;
}

/**
 * Lee (y cachea) conector/línea/teléfono del chat desde su identificador de Open Lines.
 *
 * Se usa esa fuente y no la ficha del CRM porque lo que importa es de qué canal/número llegó el
 * mensaje, no a qué contacto lo asoció Bitrix — que puede ser otro, o ninguno. Solo cachea lecturas
 * EXITOSAS: si Bitrix falla, devuelve todo null y el próximo mensaje reintenta (no deja un chat
 * mudo 10 min por un fallo transitorio).
 */
async function entidadDelChat(chatId: string | number | undefined, auth: Auth): Promise<EntidadChat> {
  if (!chatId) return VACIO;
  const clave = String(chatId);
  const ahora = Date.now();
  const guardado = cache.get(clave);
  if (guardado && guardado.hasta > ahora) return guardado.datos;
  try {
    const r: any = await callBitrix('im.dialog.get', { DIALOG_ID: `chat${clave}` }, auth);
    const partes = String(r?.entity_id ?? '').split('|');
    const datos: EntidadChat = {
      connector: partes[0] || null,
      linea: partes.length >= 2 ? partes[1] || null : null,
      telefono: partes.length >= 3 ? soloDigitos(partes[2]) || null : null,
    };
    cache.set(clave, { datos, hasta: ahora + CACHE_MS });
    return datos;
  } catch (e) {
    log.warn('listaBlanca: no se pudo leer el chat de Open Lines', { err: String(e), chatId: clave });
    return VACIO; // no se cachea el fallo: el próximo mensaje reintenta
  }
}

/** El teléfono desde el que escribe la persona, leído del propio chat de Open Lines. */
export async function telefonoDelChat(chatId: string | number | undefined, auth: Auth): Promise<string | null> {
  return (await entidadDelChat(chatId, auth)).telefono;
}

/** El ID de la LÍNEA de Open Lines del chat (p. ej. "31" WhatsApp, "93" Live Chat). Lo usa la
 *  compuerta de líneas permitidas (config.openlinesLineasPermitidas) en routes/botEvents.ts. null si
 *  no se pudo determinar. */
export async function lineaDelChat(chatId: string | number | undefined, auth: Auth): Promise<string | null> {
  return (await entidadDelChat(chatId, auth)).linea;
}

/** ¿Este chat puede recibir respuesta? Con la lista vacía, siempre. */
export async function puedeResponder(chatId: string | number | undefined, auth: Auth): Promise<boolean> {
  if (!listaBlancaActiva()) return true;
  const tel = await telefonoDelChat(chatId, auth);
  if (!tel) {
    log.info('modo prueba: no se pudo identificar el número del chat; el bot no responde', { chatId });
    return false;
  }
  const permitido = config.soloEstosNumeros.some((n) => soloDigitos(n) === tel);
  if (!permitido) log.info('modo prueba: número fuera de la lista; el bot no responde', { chatId, tel });
  return permitido;
}

/** Para las pruebas: la resolución del teléfono se cachea diez minutos. */
export function _limpiarCacheListaBlanca(): void {
  cache.clear();
}
