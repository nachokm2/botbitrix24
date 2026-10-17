/**
 * Texto que puede viajar dentro de un JSON sin romperlo.
 *
 * Un emoji como 🇺🇸 ocupa DOS unidades en una cadena de JavaScript. `slice` cuenta unidades, no
 * símbolos: si el corte cae justo en medio, la primera mitad queda huérfana. `JSON.stringify` la
 * escribe entonces como `\ud83c` —legal para JavaScript, ilegal como Unicode— y la API de Anthropic
 * rechaza el cuerpo COMPLETO con "The request body is not valid JSON: unexpected end of hex escape".
 * No se pierde un emoji: se pierde el turno entero, y el cliente recibe la disculpa genérica.
 *
 * Pasó en producción el 16-10-2026 (chat1483881): un mensaje de campaña de 645 caracteres traía la
 * bandera en la posición 300, justo el largo al que historialChat.ts recorta cada mensaje previo.
 * Y no falló una vez sino para siempre: el historial previo solo se lee cuando Redis viene vacío, y
 * la rama de error no guarda nada en Redis, así que cada mensaje siguiente volvía a armar el mismo
 * recorte roto. Como el texto venía de un envío masivo, el pozo esperaba a todos sus destinatarios.
 */

/** Recorta a `max` unidades sin partir un símbolo en dos: si la última entra a medias, se deja fuera. */
export function recortar(texto: string, max: number, sufijo = '…'): string {
  if (texto.length <= max) return texto;
  const ultima = texto.charCodeAt(max - 1);
  const corte = ultima >= 0xd800 && ultima <= 0xdbff ? max - 1 : max;
  return texto.slice(0, corte) + sufijo;
}

/** ¿Tiene mitades sueltas? */
const MITAD_SUELTA = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Repara mitades sueltas vengan de donde vengan: WhatsApp, un campo del CRM, el recorte de un
 * tercero. Reemplaza cada una por el carácter de reemplazo (�), que es feo pero inocuo — lo que no
 * es inocuo es que la petición entera se caiga.
 */
export function repararTexto(texto: string): string {
  if (!MITAD_SUELTA.test(texto)) return texto;
  // `toWellFormed` existe desde Node 20; el package.json todavía declara >=18.
  if (typeof (String.prototype as any).toWellFormed === 'function') return (texto as any).toWellFormed();
  return texto.replace(new RegExp(MITAD_SUELTA.source, 'g'), '\uFFFD');
}

/**
 * Último filtro antes de la API: recorre el payload y repara toda cadena, EN SITIO. Se modifica el
 * arreglo original a propósito — es el mismo que después se guarda en Redis como historial, y dejar
 * ahí una mitad suelta condenaría también a todos los turnos siguientes.
 */
export function repararEnSitio(valor: any): void {
  if (!valor || typeof valor !== 'object') return;
  for (const k of Array.isArray(valor) ? valor.keys() : Object.keys(valor)) {
    const v = (valor as any)[k];
    if (typeof v === 'string') (valor as any)[k] = repararTexto(v);
    else if (v && typeof v === 'object') repararEnSitio(v);
  }
}
