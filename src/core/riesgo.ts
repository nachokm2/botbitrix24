/**
 * Mensajes que pueden indicar que la persona está en riesgo. Es PURO (sin I/O).
 *
 * Una persona escribió un mensaje que mencionaba el suicidio. El bot le respondió con cuidado, pero
 * después le mandó cuatro recordatorios de la maestría y nadie del equipo se enteró (chat 1572425,
 * 03-11-2026). En esos casos no se vende: el bot responde con calma, los recordatorios se cortan y
 * una persona del equipo recibe el aviso para revisar la conversación.
 *
 * Carver atiende programas de Psicología y salud mental: "prevención del suicidio" puede ser una
 * pregunta académica. La palabra sola cuenta como riesgo salvo que venga con un contexto de estudio;
 * las frases en primera persona ("quiero morir", "quitarme la vida") cuentan siempre.
 */

const norm = (s: string) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const PRIMERA_PERSONA =
  /\b(me quiero (morir|matar|suicidar)|quiero (morir(me)?|matarme|suicidarme)|me voy a (matar|suicidar|quitar la vida)|quitarme la vida|acabar con mi vida|no quiero (seguir )?vivir(?! (con|sola|solo|en|aqui|ahi|alla|junto|cerca|lejos|asi|de))|pienso en (matarme|suicidarme|morir)|hacerme dano|autolesion(arme|o))\b/;
const PALABRA = /\bsuicid\w*/;
const CONTEXTO_ACADEMICO =
  /\b(prevencion|programa|curso|maestria|licenciatura|asignatura|materia|malla|modulo|tema|estudio|estudiar|investigacion|tesis|clase|catedra|diplomado|psicologia|salud mental|intervencion|protocolo|riesgo suicida|conducta suicida|ideacion)\b/;

/** ¿El mensaje puede indicar que la persona está en riesgo? */
export function mensajeDeRiesgo(texto: string): boolean {
  const t = norm(texto);
  if (!t) return false;
  if (PRIMERA_PERSONA.test(t)) return true;
  return PALABRA.test(t) && !CONTEXTO_ACADEMICO.test(t);
}

/** Marca del chat tras un mensaje de riesgo: mientras dure, no salen recordatorios de venta. */
export const RIESGO_KEY = (dialogId: string) => `riesgo:${dialogId}`;
export const RIESGO_TTL_SEG = 14 * 24 * 3600;

/** Lo que se le agrega al prompt del turno cuando el mensaje puede indicar riesgo. */
export const BLOQUE_RIESGO = `

MENSAJE QUE PUEDE INDICAR RIESGO: lo que escribió la persona puede significar que está pasando por un momento muy difícil. En este turno NO hables de programas, precios, becas ni matrícula, y no uses ninguna herramienta comercial. Responde con calma, en dos o tres frases y sin marcar género: dile que lamentas lo que está viviendo y que aquí se le escucha, pregúntale cómo está ahora y, si siente que su vida corre peligro, pídele que busque ayuda de inmediato en los servicios de emergencia de su país o con alguien de confianza. NO des números de teléfono ni nombres de líneas de ayuda: no están verificados, y un número equivocado a alguien en riesgo es peor que ninguno; habla de los servicios de emergencia de su país. No minimices lo que dijo, no lo diagnostiques y no le pidas datos.`;
