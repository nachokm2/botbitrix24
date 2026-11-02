/**
 * Lo nuestro que vuelve al chat como si fuera del cliente.
 *
 * Por WhatsApp, Bitrix le entrega al bot cosas que mandamos nosotros mezcladas con lo que escribe la
 * persona. Dos formas, vistas el fin de semana del 31-10-2026:
 *
 * 1. Respuesta a una plantilla. El conector cita la plantilla entre dos líneas de guiones y debajo
 *    pone lo que contestó la persona («Más información», «Si»…). El archivo del encabezado de la
 *    plantilla (la imagen del programa, el video de Global Talks) viene adjunto en el mismo evento,
 *    pero es nuestro: 75 de los 90 adjuntos del fin de semana eran eso. El video se tomó por un audio
 *    del cliente que no se pudo transcribir, y el bot le pidió a Ariel que escribiera su consulta
 *    cuando solo había contestado «Si» (chat 1562493).
 *
 * 2. Lo que sale por ChatApp, como el PDF del brochure que manda el propio bot, vuelve con
 *    «Sent from external application». El bot le contestaba «Perfecto, ya lo tiene disponible» a su
 *    propio envío (5 veces).
 */

const SEPARADOR = /^-{20,}\s*$/gm;

// Un archivo que de verdad mandó la persona llega como enlace al CDN de ChatApp en su parte del texto.
const ARCHIVO_DEL_CLIENTE = /\[URL=https?:\/\/[^\]]*chatapp\.online/i;

/** ¿Es un envío nuestro por ChatApp que volvió al chat? No hay que responderlo. */
export function esEnvioNuestroPorChatApp(texto: string | undefined): boolean {
  return /^\s*\[B\]\s*Sent from external application\s*\[\/B\]/i.test(String(texto ?? ''));
}

/** Lo que contestó la persona a una plantilla citada, o null si el mensaje no cita una plantilla. */
export function respuestaAPlantilla(texto: string | undefined): string | null {
  const t = String(texto ?? '').trim();
  const separadores = [...t.matchAll(SEPARADOR)];
  if (separadores.length < 2 || separadores[0].index !== 0) return null;
  const ultimo = separadores[separadores.length - 1];
  return t.slice((ultimo.index ?? 0) + ultimo[0].length).trim();
}

/**
 * ¿Los adjuntos del evento son el encabezado de la plantilla citada? Sí, salvo que la parte de la
 * persona traiga su propio archivo.
 */
export function adjuntosSonDeLaPlantilla(texto: string | undefined): boolean {
  const respuesta = respuestaAPlantilla(texto);
  return respuesta !== null && !ARCHIVO_DEL_CLIENTE.test(respuesta);
}
