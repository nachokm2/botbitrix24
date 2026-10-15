import { callBitrix } from '../bitrix/client';
import { config } from '../config';
import { log } from '../log';
import type { Auth } from '../store';

/**
 * ¿Hay una persona dentro de este chat de Open Lines?
 *
 * El caso que lo motivó (deal #3649251, 15-oct-2026): una asesora se unió al chat a las 13:11, lo
 * recogió a las 13:12 y le escribió al cliente a las 13:13. A las 13:35 el cliente respondió y el
 * bot contestó por encima de ella.
 *
 * Por qué no bastaba lo que ya había: el bot se calla cuando VE un mensaje de un operador, pero
 * Bitrix no le entrega esos mensajes como evento. Para el bot, entre su último turno y el del
 * cliente no pasó nada. Revisando el registro de un mes, el bot nunca recibió un solo mensaje de
 * operador en una conversación que ya estuviera atendiendo.
 *
 * Lo que SÍ se puede ver es la lista de participantes del chat: cuando alguien lo recoge, queda
 * dentro. Una persona del portal ahí —ni el bot, ni el cliente, que entra como externo— significa
 * que la conversación ya tiene dueño.
 *
 * Ante cualquier duda devuelve false y el bot sigue atendiendo: dejar mudo al bot por una consulta
 * fallida es peor que una respuesta de más, porque el cliente se queda esperando a nadie.
 */

type ParticipanteIM = { id?: number | string; bot?: boolean; extranet?: boolean; connector?: boolean };

const CACHE_MS = 60_000;
const cache = new Map<string, { hay: boolean; hasta: number }>();

export async function hayOperadorEnElChat(
  chatId: string | number | undefined,
  auth: Auth,
  clientId?: string | null,
): Promise<boolean> {
  if (!config.detectarOperadorEnChat || !chatId) return false;
  const clave = String(chatId);
  const ahora = Date.now();
  const guardado = cache.get(clave);
  // Solo se cachea el "no hay nadie": en cuanto hay operador, quien llama marca el traspaso y ya no
  // vuelve a preguntar. Cachear el "sí" arriesgaría sostener un silencio que ya no corresponde.
  if (guardado && guardado.hasta > ahora && !guardado.hay) return false;

  try {
    const r = await callBitrix<ParticipanteIM[]>('im.dialog.users.list', { DIALOG_ID: `chat${clave}` }, auth);
    const participantes = Array.isArray(r) ? r : [];
    if (!participantes.length) return false;

    const humano = participantes.find((u) => {
      const id = String(u?.id ?? '');
      if (!id) return false;
      if (u.bot || u.connector) return false; // el propio bot y los conectores del canal
      if (u.extranet) return false; // así entra el cliente por WhatsApp
      if (config.botId && id === String(config.botId)) return false;
      if (clientId && id === String(clientId)) return false;
      return true;
    });

    const hay = Boolean(humano);
    cache.set(clave, { hay, hasta: ahora + CACHE_MS });
    if (hay) log.info('hay una persona en el chat: el bot no responde', { chatId: clave, operador: humano?.id });
    return hay;
  } catch (e) {
    // Fail-open a propósito: ver arriba.
    log.warn('hayOperadorEnElChat: no se pudo leer la lista de participantes', { err: String(e), chatId: clave });
    return false;
  }
}

/** Para las pruebas: la caché es de proceso y persiste entre casos. */
export function _limpiarCacheOperadores(): void {
  cache.clear();
}
