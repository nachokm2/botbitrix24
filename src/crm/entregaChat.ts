import { callBitrix } from '../bitrix/client';
import { config } from '../config';
import { log } from '../log';
import type { Auth } from '../store';
import type { Derivacion } from './asignacionAsesores';

/**
 * A quién se le entrega el CHAT al derivar (0 = a la cola de la línea).
 *
 * Con punto de entrada configurado (Carver), va a esa persona cuando ningún asesor vigente quedó a
 * cargo: chats sin negociación (solo lead o contacto), negociación cerrada, de otro embudo o sin
 * responsable del equipo. Antes iba a la cola y Bitrix se lo daba a cualquier operador de la línea,
 * aunque la negociación y la tarea quedaran con el punto de entrada. Con un asesor vigente a cargo
 * sigue yendo a la cola, como siempre.
 */
export function destinoDelChat(derivacion: Derivacion | false | undefined): number {
  if (!config.derivarATodo) return 0;
  if (derivacion && typeof derivacion === 'object' && !derivacion.alPuntoDeEntrada) return 0;
  return config.derivarATodo;
}

/**
 * Entrega la sesión de Open Lines: a la persona si hay destino, y si no a la cola. Si Bitrix no acepta
 * el traspaso a la persona (por ejemplo, porque no es operadora de esa línea), va a la cola: el bot ya
 * dejó de responder y quedarse con el chat lo dejaría sin nadie que lo lea.
 *
 * Los errores de la cola se propagan como antes: "Operator is not a bot" quiere decir que la sesión ya
 * la tiene una persona, y cada llamador decide qué hacer con eso.
 */
export async function entregarSesion(chatId: string | number, destino: number, auth: Auth): Promise<'persona' | 'cola'> {
  if (destino) {
    try {
      await callBitrix('imopenlines.bot.session.transfer', { CHAT_ID: chatId, USER_ID: destino, LEAVE: 'N' }, auth);
      return 'persona';
    } catch (e) {
      log.warn('entregarSesion: Bitrix no aceptó el traspaso a la persona; va a la cola', { err: String(e), chatId, destino });
    }
  }
  await callBitrix('imopenlines.bot.session.operator', { CHAT_ID: chatId }, auth);
  return 'cola';
}
