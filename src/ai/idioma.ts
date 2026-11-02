/**
 * Idioma del cliente.
 *
 * Carver es una universidad estadounidense con alumnos en toda Latinoamérica: de sus leads, el 10%
 * tiene número de Estados Unidos y hay brasileños entre ellos. El bot responde solo en español,
 * así que a quien escribe en portugués o en inglés se le contesta en otro idioma — y eso se lee
 * como que nadie lo está atendiendo de verdad.
 *
 * La detección es deliberadamente tosca: palabras funcionales frecuentes, que son las que mejor
 * distinguen idiomas en textos cortos. No se usa el modelo porque esto corre en TODOS los turnos y
 * un clasificador por turno costaría más que el problema que resuelve.
 *
 * Ante la duda devuelve 'es': equivocarse hacia el español deja las cosas como estaban, mientras
 * que marcar portugués por error haría que el bot le conteste en portugués a un chileno.
 */

export type Idioma = 'es' | 'pt' | 'en';

/**
 * Palabras que casi solo aparecen en un idioma. Se evitan las que comparten español y portugués
 * ("para", "de", "que"...), que son justamente las que confunden en frases cortas.
 *
 * Ojo con las que se ven portuguesas pero sin acento también son español. "Cómo funciona, cuándo
 * comienza y los valores" (Mónica, de Chile, 02-11-2026) sumaba dos marcas con "como funciona" y
 * "valores", y el bot le contestó en portugués. Por eso no están "valores", "curso", "como
 * funciona" ni "queria saber", y en inglés tampoco "me" ni "master" (máster).
 *
 * Los patrones van SIN acentos porque el texto se normaliza antes de compararlos: el `\b` de
 * JavaScript no considera letra a una vocal acentuada, así que /\bvocê\b/ NO coincide con "você ".
 * Además, mucha gente escribe sin acentos por WhatsApp.
 */
const MARCAS: Record<Exclude<Idioma, 'es'>, RegExp[]> = {
  pt: [
    /\b(voce|voces)\b/,
    /\b(obrigad[oa])\b/,
    /\b(nao)\b/,
    /\b(sim)\b/,
    /\b(sao)\b/,
    /\b(gostaria)\b/,
    /\b(preco|informacoes)\b/,
    /\b(mestrado|graduacao|faculdade)\b/,
    /\b(bom dia|boa tarde|boa noite)\b/,
    /\b(quanto custa)\b/,
    /\b(eu|meu|minha|tambem)\b/,
    /\b(quero|posso|tenho|estou|isso|muito)\b/,
  ],
  en: [
    /\b(hello|hi|hey)\b/,
    /\b(thanks|thank you)\b/,
    /\b(im|my)\b/,
    /\b(the|and|for|with)\b/,
    /\b(would like|want to|how much|how can)\b/,
    /\b(information|program|degree|bachelor)\b/,
    /\b(please|could you|can you)\b/,
  ],
};

/**
 * Palabras que solo son español. No deciden nada por sí solas: sirven de contrapeso, para que un
 * mensaje claramente en español no cambie de idioma por dos palabras que suenan a otro.
 */
const ESPANOL: RegExp[] = [
  /\b(el|los|las|del)\b/,
  /\b(y)\b/,
  /\b(si|eso|esto)\b/,
  /\b(cuando|cuanto|cuanta|cuantos|donde)\b/,
  /\b(quiero|quisiera|puedo|puedes|puede|tengo|necesito)\b/,
  /\b(usted|ustedes|gracias|hola|buenas)\b/,
  /\b(pero|muy|soy|estoy|tambien)\b/,
];

const MINIMO_CARACTERES = 12; // "ok", "si", "hola" no alcanzan para decidir nada
const MINIMO_MARCAS = 2; // una sola coincidencia es ruido: "no" existe en portugués y en español

const norm = (s: string) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // sin acentos: ver la nota de MARCAS
    .replace(/\s+/g, ' ')
    .trim();

export function detectarIdioma(texto: string): Idioma {
  const t = norm(texto);
  if (t.length < MINIMO_CARACTERES) return 'es';
  const puntajes = (Object.keys(MARCAS) as Array<Exclude<Idioma, 'es'>>)
    .map((idioma) => ({ idioma, n: MARCAS[idioma].filter((re) => re.test(t)).length }))
    .sort((a, b) => b.n - a.n);
  const mejor = puntajes[0];
  if (!mejor || mejor.n < MINIMO_MARCAS) return 'es';
  // Empate entre portugués e inglés: no hay señal clara, se queda en español.
  if (puntajes.length > 1 && puntajes[1].n === mejor.n) return 'es';
  // El otro idioma tiene que ganarle al español, no solo llegar al mínimo.
  if (ESPANOL.filter((re) => re.test(t)).length >= mejor.n) return 'es';
  return mejor.idioma;
}

const NOMBRE: Record<Idioma, string> = { es: 'español', pt: 'portugués', en: 'inglés' };

/**
 * Instrucción para el prompt cuando el cliente no escribe en español. Se anexa al system del turno,
 * no al historial: si la persona vuelve al español en el mensaje siguiente, la instrucción
 * desaparece sola en vez de quedar pegada el resto de la conversación.
 */
export function bloqueIdioma(idioma: Idioma): string {
  if (idioma === 'es') return '';
  return (
    `\n\nIDIOMA: este cliente te está escribiendo en ${NOMBRE[idioma]}. Respóndele en ${NOMBRE[idioma]}, ` +
    'con el mismo tono cordial de siempre, y sigue en ese idioma mientras él lo use. Los nombres ' +
    'propios de los programas déjalos como están, sin traducirlos. Si no estás seguro de algo en ' +
    `${NOMBRE[idioma]}, prefiere una frase simple antes que una traducción dudosa.`
  );
}
