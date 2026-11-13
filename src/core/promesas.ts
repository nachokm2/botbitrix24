/**
 * Lo que el bot promete y lo que el cliente quiere hacer, leído del texto. Es PURO (sin I/O).
 *
 * Promesas: en Carver la regla de derivar en silencio le pide al bot decir "yo lo confirmo con el
 * área y le respondo por acá". Bien hecho, eso va junto con escalar_a_humano. Mal hecho, queda una
 * promesa sin nadie detrás: a un interesado de Ecuador le dijo "confirmaré la documentación de
 * acreditación con el área académica" y "los plazos los confirmaré", no derivó, y nadie se enteró
 * (chat 1560069, 30-10-2026). Si la respuesta promete volver con algo y en el turno no hubo
 * derivación, quien corresponda tiene que recibir el pendiente (ver ai/agentLoop.ts).
 *
 * Intención de pago: un cliente preguntó tres veces cuánto pagaba al contado y el bot le volvió a
 * preguntar si quería el enlace; al asesor no le llegó nada (chat 1561991, 31-10-2026).
 */

const norm = (s: string) =>
  (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

/** Frases del texto, conservando el signo final (para distinguir una oferta "¿Se lo confirmo?"). */
function frases(texto: string): string[] {
  return texto
    .split(/(?<=[.!?])\s+|\n+/)
    .map((f) => f.trim())
    .filter(Boolean);
}

// Futuro explícito: "confirmaré", "le escribiré". Con "te" también: Carver tutea desde el 13-11-2026.
const FUTURO =
  /\b(confirmare|verificare|consultare|averiguare|revisare|gestionare|coordinare|(le|te) (escribire|respondere|avisare|enviare|hare llegar|contare|informare))\b/;
// "lo confirmo con el área académica", "verifico con admisiones". Sin "que" después del verbo: "le
// confirmo que el programa dura 12 meses" es una afirmación, no una promesa.
const CON_AREA =
  /\b(confirmo|verifico|consulto|reviso|averiguo|gestiono|coordino|valido)\b(?!\s+que)[^.!?\n]{0,40}\b(con|en)\s+(el\s+|la\s+|los\s+|las\s+)?(area|areas|equipo|admision|admisiones|finanzas|academica|academico|direccion|departamento|coordinacion|registro|soporte)\b/;
// "le aviso en cuanto esté listo", "le respondo a la brevedad".
const CON_PLAZO =
  /\b(le|te)\s+(respondo|escribo|aviso|confirmo|cuento|informo|envio|comparto)\b[^.!?\n]{0,40}\b(a la brevedad|apenas|en cuanto|pronto|hoy mismo|manana|el lunes|el martes|el miercoles|el jueves|el viernes|el sabado|el domingo|el proximo|durante el dia|en el dia|lo antes posible|en breve|mas tarde)\b/;
// "le respondo por acá" (sin "le escribo por acá", que suele ir seguido del dato en el mismo mensaje).
const POR_ACA = /\b(le|te)\s+(respondo|aviso|confirmo)\s+(por aca|por aqui|por este medio|por este chat)\b/;
// "... y le confirmo." al cierre de la frase.
const Y_LE_AL_FINAL = /\by\s+(se lo|te lo|le|te|lo)\s+(confirmo|aviso|respondo|cuento|informo)\s*[.!]*$/;

/** La frase con la que la respuesta promete volver con algo, o null si no promete nada. Las
 *  preguntas no cuentan: "¿Quiere que se lo confirme?" es una oferta, todavía no un compromiso. */
export function promesaDeSeguimiento(texto: string): string | null {
  for (const f of frases(texto ?? '')) {
    if (/\?\s*$/.test(f) || /^¿/.test(f)) continue;
    const n = norm(f);
    if (FUTURO.test(n) || CON_AREA.test(n) || CON_PLAZO.test(n) || POR_ACA.test(n) || Y_LE_AL_FINAL.test(n)) return f;
  }
  return null;
}

// Envío por correo: "le envío el detalle al correo que tenemos registrado", "se lo hago llegar a su
// correo", "le llegará al mail". Así le habló el bot a un interesado de Psicología, dos veces, sin
// poder enviar nada (chat 1583541, 07-11-2026): el presente "le envío" no lo detecta FUTURO, y sin
// esto la promesa no le llegaba a nadie. "Le comparto mi correo" o "puede escribirme al correo" no
// prometen un envío y no cuentan.
const ENVIO_CORREO =
  /\b(envio|enviare|enviamos|enviaremos|mando|mandare|mandamos|hago llegar|hare llegar|haremos llegar|acabo de enviar|acabo de mandar|(le|te) (envie|mande|escribo|escribire)|llegara|llegaran)\b/;
const CORREO = /\b(correo|mail|email|e-mail|bandeja de entrada)\b/;

/** La frase en la que la respuesta dice que envía (o envió) algo al correo, o null. Las preguntas no
 *  cuentan: "¿Quiere que se lo envíe al correo?" es una oferta. */
export function promesaDeCorreo(texto: string): string | null {
  for (const f of frases(texto ?? '')) {
    if (/\?\s*$/.test(f) || /^¿/.test(f)) continue;
    const n = norm(f);
    if (ENVIO_CORREO.test(n) && CORREO.test(n)) return f;
  }
  return null;
}

// "quiero pagar", "cómo pago", "si pago todo de contado", "link de pago". No incluye "cancelar":
// en varios países es pagar, pero "quiero cancelar mi matrícula" es lo contrario.
const PAGO =
  /\b(quiero|quisiera|deseo|voy a|me gustaria|necesito|como puedo|donde puedo)\s+(pagar|hacer el pago|realizar el pago|matricularme|inscribirme)\b|\b(enlace|link)\s+(de|para)\s+(pago|pagar)\b|\bproceder con el pago\b|\bpag(o|ar|aria|are)\s+(todo\s+)?(de\s+|al\s+)?contado\b|\bcomo\s+(se paga|pago|hago el pago)\b|\bdonde\s+(se paga|pago)\b|\bdatos\s+(para|de)\s+(la\s+)?transferencia\b|\bnumero de cuenta\b/;

/** ¿El cliente dice que quiere pagar o pregunta cómo hacerlo? */
export function intencionDePago(mensaje: string): boolean {
  return PAGO.test(norm(mensaje ?? ''));
}
