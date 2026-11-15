/**
 * Modo internacional: cuántas veces el bot ya le preguntó a la persona a qué se dedica.
 *
 * La regla del prompt («a lo más dos veces») no bastó: el 15-11-2026, una hora después de
 * publicarla, el bot le preguntó seis veces seguidas a una persona que buscaba trabajo «what field
 * are you from, are you a recent graduate…?», una por mensaje, mientras ella preguntaba otras cosas.
 * Contado en el código, el aviso va al system del turno y desaparece si el historial vence.
 */

// Preguntas por el trabajo, el área o la formación, en inglés, hinglish e hindi.
const PREGUNTA_POR_TRABAJO =
  /what (kind of )?(work|job)\b|what do you (do|currently do)\b|what (field|industry|domain|sector)\b|which (field|industry|domain|sector)\b|what('s| is) your (field|role|background|profession|work|job|industry)\b|your (educational )?background\b|recent graduate|work experience|(field|line) of work|aap kya (kaam|karte)|kis (field|kshetra)|क्या काम|किस (field|क्षेत्र)/i;

type Mensaje = { role: string; content: unknown };

function textoDe(m: Mensaje): string {
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join(' ');
  }
  return '';
}

/** Mensajes del bot en el historial que le preguntan a la persona por su trabajo o formación. */
export function vecesQuePreguntoPorTrabajo(historial: Mensaje[]): number {
  return historial.filter((m) => {
    if (m.role !== 'assistant') return false;
    const t = textoDe(m);
    // Solo las frases que preguntan: «as a data analyst you'd…» no cuenta.
    return t
      .split(/(?<=[.!?।])\s+/)
      .some((frase) => frase.includes('?') && PREGUNTA_POR_TRABAJO.test(frase));
  }).length;
}

/** Aviso para el system del turno si ya preguntó dos veces o más; vacío si no. */
export function bloqueNoRepetirPreguntaPorTrabajo(historial: Mensaje[]): string {
  const n = vecesQuePreguntoPorTrabajo(historial);
  if (n < 2) return '';
  return (
    `\n\nTURN NOTE (strict): you have already asked about their work, field or background ${n} times in this conversation. ` +
    'Do not ask about it again in this reply, in any form (job, field, role, industry, studies, graduate or experience). ' +
    'Answer what they said; if you ask something, make it about the next step, for example whether they would like to know how to enrol.'
  );
}
