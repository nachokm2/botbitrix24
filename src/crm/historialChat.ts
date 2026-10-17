import { callBitrix } from '../bitrix/client';
import type { Auth } from '../store';
import { log } from '../log';
import { recortar } from '../core/textoSeguro';

/**
 * Lee lo que ya se habló en un chat ANTES de que el bot entrara.
 *
 * Hasta ahora, al sumar el bot a una conversación en curso arrancaba en blanco: la memoria entre
 * sesiones (crm/chat.ts:loadPriorContext) son las notas que el PROPIO bot dejó en el CRM, así que de
 * un chat atendido por una persona no sabía nada. Resultado: volvía a preguntar lo que el cliente ya
 * había contestado, y podía contradecir lo que un colega acababa de decirle.
 *
 * Se lee solo al abrir la conversación, no en cada turno: a partir de ahí el historial local ya
 * acumula todo.
 */

const LIMITE_MENSAJES = 30; // suficiente para el contexto reciente sin inflar cada prompt
const LARGO_MAX_MENSAJE = 300;
const LARGO_MAX_BLOQUE = 4000;

type MensajeBitrix = { id?: any; author_id?: any; AUTHOR_ID?: any; text?: string; TEXT?: string; date?: string; DATE?: string };

/** Limpia el formato BBCode de Bitrix y los adjuntos, que en texto plano solo estorban. */
function limpiar(texto: string): string {
  return texto
    .replace(/\[br\]/gi, ' ')
    .replace(/\[\/?[A-Za-z]+(=[^\]]*)?\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export type HistorialPrevio = { instruccion: string; transcripcion: string };

/**
 * Devuelve el historial previo del chat, o null si no hay nada que aportar.
 * `clientId` es el usuario que el bot considera el cliente: todo lo demás lo escribió el equipo.
 *
 * Se devuelve en dos partes a propósito. La transcripción la escribieron terceros, así que viaja
 * dentro del marcador de contenido NO confiable (ver ai/agentLoop.ts); la instrucción es nuestra y
 * tiene que ir fuera, porque ese mismo marcador dice que no se obedezca nada de lo que contiene.
 */
export async function leerHistorialPrevio(
  dialogId: string,
  clientId: string | undefined,
  auth: Auth,
  msgIdActual?: any,
): Promise<HistorialPrevio | null> {
  if (!dialogId) return null;
  let crudo: any;
  try {
    crudo = await callBitrix('im.dialog.messages.get', { DIALOG_ID: dialogId, LIMIT: LIMITE_MENSAJES }, auth);
  } catch (e) {
    // Un portal sin el scope `im` o sin el método devuelve error: no es motivo para no responderle
    // al cliente, simplemente se arranca sin este contexto, como antes.
    log.warn('leerHistorialPrevio: im.dialog.messages.get falló', { err: String(e), dialogId });
    return null;
  }

  const lista: MensajeBitrix[] = Array.isArray(crudo) ? crudo : (crudo?.messages ?? crudo?.MESSAGES ?? []);
  if (!Array.isArray(lista) || lista.length === 0) return null;

  // Bitrix los devuelve del más nuevo al más viejo; el prompt los necesita en orden de conversación.
  const ordenados = [...lista].reverse();
  const lineas: string[] = [];
  let huboEquipo = false;

  for (const m of ordenados) {
    // El mensaje que acaba de llegar ya va como turno del usuario: incluirlo acá lo duplicaría.
    if (msgIdActual && String(m.id ?? '') === String(msgIdActual)) continue;
    const texto = limpiar(String(m.text ?? m.TEXT ?? ''));
    if (!texto) continue; // adjuntos sin texto, mensajes de sistema
    const autor = String(m.author_id ?? m.AUTHOR_ID ?? '');
    const esCliente = Boolean(clientId) && autor === clientId;
    if (!esCliente) huboEquipo = true;
    // Con `recortar` y no con `slice`: el corte no puede caer en medio de un emoji (ver core/textoSeguro.ts).
    const recorte = recortar(texto, LARGO_MAX_MENSAJE);
    lineas.push(`${esCliente ? 'Cliente' : 'Equipo'}: ${recorte}`);
  }
  if (!lineas.length) return null;

  // Si se pasa del tope, se quedan los ÚLTIMOS: lo reciente es lo que hay que no contradecir.
  let bloque = lineas.join('\n');
  while (bloque.length > LARGO_MAX_BLOQUE && lineas.length > 1) {
    lineas.shift();
    bloque = lineas.join('\n');
  }

  const instruccion = huboEquipo
    ? 'Esta conversación YA venía en curso y un colega participó en ella. Retómala donde quedó: NO vuelvas a ' +
      'presentarte, NO repitas preguntas ya respondidas y NO contradigas lo que se le dijo. Si algo de lo ' +
      'anterior no te consta, no lo confirmes: ofrece verificarlo.'
    : 'Esta conversación YA venía en curso. Retómala donde quedó: NO vuelvas a presentarte ni repitas preguntas ' +
      'que el cliente ya respondió más abajo.';

  log.info('historial previo del chat cargado', { dialogId, mensajes: lineas.length, huboEquipo });
  return { instruccion, transcripcion: bloque };
}
