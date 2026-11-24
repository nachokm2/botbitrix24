import { getJson, setJson, kvDel } from '../store/kv';

/**
 * Modo internacional: mensajes que no tienen nada que ver con la admisión (ofertas de trabajo, de
 * tutoría o de servicios, publicidad, pedidos de dinero).
 *
 * El 18-11-2026 alguien ofreció un puesto de tutor y mandó fotos, videos y seis mensajes en un minuto: el
 * bot contestó siete veces lo mismo («este chat es solo para admisiones…»). Se contestan dos veces, con
 * palabras distintas, y desde la tercera el bot calla hasta que la persona escriba algo del programa.
 *
 * Cómo se sabe. Lo decide el modelo, que ve el mensaje entero: empieza su respuesta con la marca
 * [OFF_TOPIC] (ver promptInternacional). El código la quita antes de guardarla en el historial y de
 * enviarla, así que la persona nunca la lee.
 */

export const MARCA_FUERA_DE_TEMA = '[OFF_TOPIC]';
/** Cuántas respuestas seguidas fuera de tema se envían; las siguientes no. */
export const MAX_RESPUESTAS_FUERA_DE_TEMA = 2;

const KEY = (dialogId: string) => `internacional:fuera_de_tema:${dialogId}`;
const TTL_SEG = 24 * 3600;

const MARCA = /\[\s*off[\s_-]*topic\s*\]/gi;

/** Quita la marca del texto (esté donde esté) y dice si estaba. */
export function separarFueraDeTema(texto: string): { texto: string; fuera: boolean } {
  const original = String(texto ?? '');
  if (!original.match(MARCA)) return { texto: original, fuera: false };
  const limpio = original
    .replace(MARCA, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { texto: limpio, fuera: true };
}

/**
 * Cuenta los turnos seguidos fuera de tema de esta conversación. Un turno que sí habla del programa
 * reinicia la cuenta: quien vuelve al tema recupera la respuesta.
 */
export async function contarFueraDeTema(dialogId: string, fuera: boolean): Promise<number> {
  if (!fuera) {
    await kvDel(KEY(dialogId)).catch(() => {});
    return 0;
  }
  const n = ((await getJson<number>(KEY(dialogId)).catch(() => null)) ?? 0) + 1;
  await setJson(KEY(dialogId), n, TTL_SEG).catch(() => {});
  return n;
}

/** ¿Esta respuesta ya no se envía? Solo si está fuera de tema y ya se contestó el máximo de veces. */
export function debeCallar(fuera: boolean, seguidos: number): boolean {
  return fuera && seguidos > MAX_RESPUESTAS_FUERA_DE_TEMA;
}
