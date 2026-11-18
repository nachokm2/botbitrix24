/**
 * Modo internacional: prueba A/B del primer mensaje del bot (pedido del 17-11-2026).
 *
 * Del 13 al 17-11, la mitad de quienes escribieron (84 de 166) solo mandó el mensaje automático del
 * anuncio y no volvió a escribir. El primer mensaje del bot rondaba los 250 caracteres y terminaba en
 * «What kind of work do you do?». La variante B es más corta y termina en una pregunta que se contesta
 * con una palabra. Cada chat nuevo cae en una variante según su número (par: A, impar: B) y la variante
 * queda en la auditoría del turno; el resumen diario compara qué parte de cada grupo volvió a escribir.
 */

import { createHash } from 'node:crypto';

export type Variante = 'A' | 'B';

/** Variante de un chat, por un hash de su id. Con la paridad del número, los 24 primeros chats cayeron
 *  todos en B: Bitrix numera impares casi todos los chats de las líneas abiertas (17 y 18-11-2026). */
export function varianteDePrimerMensaje(dialogId: string): Variante {
  return createHash('sha1').update(String(dialogId ?? '')).digest()[0] % 2 === 0 ? 'A' : 'B';
}

/** Nota del turno para la variante B, solo en la primera respuesta. */
export const BLOQUE_PRIMER_MENSAJE_B =
  '\n\nFIRST MESSAGE (strict): this is your first reply in this chat. Write at most 280 characters in three short ' +
  'sentences: what the programme is (a 16-week live-online course, taught in English, with a Carver University ' +
  'certificate), the price (USD 400, or 4 instalments of USD 200), and ONE easy question they can answer in one word: ' +
  'whether they work with code or prefer a no-code track. No list, no other question.';
