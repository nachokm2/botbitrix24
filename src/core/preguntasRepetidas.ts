/**
 * Modo internacional: cuántas veces el bot ya le preguntó a la persona a qué se dedica.
 *
 * La regla del prompt («a lo más dos veces») no bastó: el 15-11-2026, una hora después de
 * publicarla, el bot le preguntó seis veces seguidas a una persona que buscaba trabajo «what field
 * are you from, are you a recent graduate…?», una por mensaje, mientras ella preguntaba otras cosas.
 * Contado en el código, el aviso va al system del turno y desaparece si el historial vence.
 */

// Preguntas por el trabajo, el área o la formación, en inglés, hinglish e hindi. «Do you work in a
// particular field or role?», «What's your current role?» y sobre todo «could you tell me what you do
// for work?» se escapaban (chat1604043, 16-11-2026): sin contarlas, la nota del turno no se activaba.
export const PREGUNTA_POR_TRABAJO =
  /what (kind of )?(work|job)\b|what (do )?you (do|currently do)\b|what you work (on|in|as)\b|about (your|their) (work|job|role)\b|what (field|industry|domain|sector)\b|which (field|industry|domain|sector)\b|what('s| is) your (current |main |present )?(field|role|background|profession|work|job|industry|occupation)\b|\bcurrent (role|job|profession|position)\b|\boccupation\b|do you (currently )?work (in|with|as|at|on|for)\b|your (educational )?background\b|recent graduate|work experience|(field|line) of work|aap kya (kaam|karte)|kis (field|kshetra)|क्या काम|किस (field|क्षेत्र)/i;

/** true si alguna frase con signo de pregunta pregunta por el trabajo o la formación. Solo las frases
 *  que preguntan: «as a data analyst you'd…» no cuenta. */
export function preguntaPorTrabajo(texto: string): boolean {
  return texto.split(/(?<=[.!?।])\s+/).some((frase) => frase.includes('?') && PREGUNTA_POR_TRABAJO.test(frase));
}

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
  return historial.filter((m) => m.role === 'assistant' && preguntaPorTrabajo(textoDe(m))).length;
}

/**
 * Editor que quita de una respuesta ya escrita la pregunta por el trabajo. La nota del turno no
 * bastó: a quien solo manda enlaces el modelo le vuelve a preguntar a qué se dedica (chat1604043,
 * 16-11-2026: tres reels de Instagram, tres veces «What kind of work do you do?»). Va en inglés: con
 * instrucciones en español, los editores devolvían en español mensajes en inglés.
 */
export const EDITOR_SIN_PREGUNTA_POR_TRABAJO =
  'You edit WhatsApp messages from a university admissions assistant. The assistant has already asked this person ' +
  'about their work several times. Rewrite the message removing every question about their work, job, field, role, ' +
  'industry, studies, background or coding. If no question is left, end with ONE short question asking whether they ' +
  'would like to know how to enrol. Keep everything else word by word, in the SAME language and script as the ' +
  'original (English stays English, Hinglish stays Hinglish, Devanagari stays Devanagari), with every figure, ' +
  'amount, name, link and email. Add nothing new. Return ONLY the message.';

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
