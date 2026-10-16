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
const cache = new Map<string, { tel: string | null; hasta: number }>();

/** Solo dígitos, para comparar "+56 9 2388 3848" con "56923883848". */
const soloDigitos = (s: string) => String(s ?? '').replace(/\D/g, '');

export function listaBlancaActiva(): boolean {
  return config.soloEstosNumeros.length > 0;
}

/**
 * El teléfono desde el que escribe la persona, leído del propio chat de Open Lines.
 *
 * El identificador del chat trae el conector, la línea y el número:
 *   ank_chats_app24_ca_whats_app|31|56923883848|805047
 * Se usa esa fuente y no la ficha del CRM porque en modo prueba lo que importa es de qué WhatsApp
 * llegó el mensaje, no a qué contacto lo asoció Bitrix — que puede ser otro, o ninguno.
 */
export async function telefonoDelChat(chatId: string | number | undefined, auth: Auth): Promise<string | null> {
  if (!chatId) return null;
  const clave = String(chatId);
  const ahora = Date.now();
  const guardado = cache.get(clave);
  if (guardado && guardado.hasta > ahora) return guardado.tel;
  try {
    const r: any = await callBitrix('im.dialog.get', { DIALOG_ID: `chat${clave}` }, auth);
    const partes = String(r?.entity_id ?? '').split('|');
    const tel = partes.length >= 3 ? soloDigitos(partes[2]) || null : null;
    cache.set(clave, { tel, hasta: ahora + CACHE_MS });
    return tel;
  } catch (e) {
    log.warn('listaBlanca: no se pudo leer el teléfono del chat', { err: String(e), chatId: clave });
    return null;
  }
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
