/**
 * Contraseñas y claves fuera de lo que escribe el bot y de los registros. Es PURO (sin I/O).
 *
 * Una estudiante mandó la captura de su correo de bienvenida para pedir ayuda con el acceso, y el bot
 * le contestó copiando su usuario y su contraseña en el chat (chat 1570761, 03-11-2026). Quedaron
 * escritos en la conversación, que ven varias personas del equipo, y en los registros. Una clave no
 * se escribe nunca por chat, aunque sea de la misma persona: si necesita entrar, la tiene en su correo.
 */

// "Contraseña: abc123", "clave = x", "Password: x", "PIN: 1234", "código de acceso: x". El valor es lo
// que sigue a la etiqueta hasta un espacio, coma o fin de línea.
const ETIQUETA = String.raw`(?:contrase(?:ñ|n)a|clave(?: de acceso| temporal)?|password|passwd|passcode|pin|c(?:ó|o)digo de (?:acceso|verificaci(?:ó|o)n|seguridad))`;
const CREDENCIAL_RE = new RegExp(String.raw`(\b${ETIQUETA}\b\s*(?:es|era)?\s*[:=]?\s*)([^\s,;]{4,})`, 'gi');

/** Palabras que pueden seguir a la etiqueta sin ser una clave ("la contraseña de su correo"). */
const NO_ES_VALOR = /^(de|del|la|el|su|sus|que|para|y|o|con|se|no|es|a|en|nueva|temporal|actual|correcta|incorrecta|olvidada|\[[^\]]*\])$/i;

export const CREDENCIAL_OCULTA = '[no se comparte por chat]';

/** El texto con el valor de cada clave reemplazado. `cambiado` dice si había alguna.
 *  `publicas`: texto de las fuentes del propio bot (la base de conocimiento, lo que devolvió una
 *  herramienta). Una clave que está ahí es pública y aprobada —la del registro de Florida para
 *  verificar la licencia— y no se tapa. */
export function quitarCredenciales(texto: string, publicas = ''): { texto: string; cambiado: boolean } {
  let cambiado = false;
  const limpio = String(texto ?? '').replace(CREDENCIAL_RE, (todo, etiqueta: string, valor: string) => {
    const valorLimpio = valor.replace(/[.:!?)\]]+$/, '');
    if (NO_ES_VALOR.test(valorLimpio)) return todo;
    if (publicas && valorLimpio.length >= 4 && publicas.includes(valorLimpio)) return todo;
    // Una clave real casi siempre mezcla letras y números o lleva símbolos; una palabra suelta de
    // la frase ("contraseña correcta") no.
    if (!/\d/.test(valor) && !/[^\p{L}]/u.test(valor)) return todo;
    cambiado = true;
    return `${etiqueta}${CREDENCIAL_OCULTA}`;
  });
  return { texto: limpio, cambiado };
}
