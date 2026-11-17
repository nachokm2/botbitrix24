import { getJson, setJson, kvDel } from '../store/kv';
import { respuestaAPlantilla } from './ecos';

/**
 * Modo internacional: mensajes que no dicen nada al bot y que, contestados uno por uno, lo hacen sonar
 * a máquina.
 *
 * - Solo enlaces o emojis: el 16 y 17-11-2026 una persona mandó 42 reels de Instagram seguidos y el bot
 *   contestó los 42 («I can't open Instagram links…», «Ready when you are…»). Se contesta el primero; los
 *   que siguen sin nada escrito, no, hasta que vuelva a escribir algo.
 * - Botones de plantillas en español: a India le llegaron por error plantillas de Latinoamérica con
 *   botones («Ya no estoy interesado/a», «Quiero matricularme ahora»). Quien no lee español los aprieta
 *   sin saber qué dicen.
 */

const SIN_CONTENIDO_KEY = (dialogId: string) => `internacional:sin_contenido:${dialogId}`;
const SIN_CONTENIDO_TTL_SEG = 12 * 3600;

/** ¿El texto es solo enlaces, emojis o signos? Un número cuenta como contenido («400», un teléfono). */
export function esSinContenido(texto: string): boolean {
  const sinEnlaces = String(texto ?? '')
    .replace(/\[URL=[^\]]*\][\s\S]*?\[\/URL\]/gi, ' ')
    .replace(/\[URL\][\s\S]*?\[\/URL\]/gi, ' ')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/\b[\w-]+(?:\.[\w-]+)+\/\S*/g, ' ');
  return !/[\p{L}\p{N}]/u.test(sinEnlaces);
}

/** Registra un mensaje sin contenido y dice si el anterior también lo fue (entonces el bot calla). */
export async function repiteSinContenido(dialogId: string): Promise<boolean> {
  const n = ((await getJson<number>(SIN_CONTENIDO_KEY(dialogId))) ?? 0) + 1;
  await setJson(SIN_CONTENIDO_KEY(dialogId), n, SIN_CONTENIDO_TTL_SEG);
  return n >= 2;
}

/** La persona escribió algo: el próximo enlace suelto vuelve a tener respuesta. */
export async function olvidarSinContenido(dialogId: string): Promise<void> {
  await kvDel(SIN_CONTENIDO_KEY(dialogId)).catch(() => {});
}

/**
 * ¿El nombre parece un nombre de usuario y no el de una persona? Con números, @, punto o guion bajo.
 * El bot saludó «Hi machineali807» y «Welcome, kumarmuruga082» (16-11-2026): mejor saludar sin nombre.
 */
export function pareceNombreDeUsuario(nombre: string | null | undefined): boolean {
  return /[\d@_.]/.test(String(nombre ?? ''));
}

/** Texto que acompaña en el turno una imagen sin texto (botEvents), en el modo internacional. */
export const IMAGEN_SIN_TEXTO_INTERNACIONAL =
  '(the person sent an image with no text: do not describe what it shows; if it is not about the programme, say kindly that you can help with the programme)';

/** Lo que escribió la persona además del mensaje que deja el anuncio (que termina en «Put AI to Work»). */
function sinElAnuncio(t: string): string {
  const i = t.toLowerCase().lastIndexOf('put ai to work');
  const resto = i >= 0 ? t.slice(i + 'put ai to work'.length) : t;
  return resto.replace(/hello!?\s*can i get more info on this\??/gi, ' ');
}

/** ¿Lo único que escribió la persona es el mensaje del anuncio, enlaces, emojis o fotos sin texto? A
 *  ellos se les mandan menos recordatorios (17-11-2026: 369 recordatorios, ninguna respuesta con interés). */
export function soloMensajeDelAnuncio(textos: string[]): boolean {
  return textos
    .map((t) => String(t ?? '').trim())
    .filter(Boolean)
    .every((t) => {
      const resto = sinElAnuncio(t).replace(/\[(imagen|image)\]/gi, ' ').trim();
      return !resto || resto === IMAGEN_SIN_TEXTO_INTERNACIONAL || /^El cliente envió una imagen sin texto/.test(resto) || esSinContenido(resto);
    });
}

const BOTONES: Array<[RegExp, string]> = [
  [/^ya no estoy interesad[oa](\/[oa])?\.?$/i, "I'm no longer interested"],
  [/^quiero matricularme( ahora)?\.?$/i, 'I want to enrol now'],
  [/^quiero estudiar m[aá]s adelante\.?$/i, 'I want to study later'],
];

/**
 * Si el mensaje es la respuesta a una plantilla en español (cita + botón), la nota que lo describe en
 * inglés para el modelo; si no, null.
 */
export function botonDePlantillaEnEspanol(texto: string): string | null {
  const respuesta = respuestaAPlantilla(texto);
  if (respuesta === null) return null;
  const citado = String(texto).slice(0, String(texto).lastIndexOf(respuesta));
  const enEspanol = /\b(hola|estamos|postulaci[oó]n|admisi[oó]n|deseas|quieres|conectarte|aprender)\b/i.test(citado);
  if (!enEspanol) return null;
  const limpio = respuesta.replace(/\s+/g, ' ').trim();
  const conocido = BOTONES.find(([rx]) => rx.test(limpio));
  if (!conocido && limpio.split(' ').length > 6) return null; // escribió algo propio debajo de la cita
  const significa = conocido ? ` (it means "${conocido[1]}")` : '';
  return `[The person tapped the button "${limpio}"${significa} on an automated message in Spanish that they may not have understood.]`;
}
