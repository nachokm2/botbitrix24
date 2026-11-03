/**
 * El primer mensaje del bot se presenta con el nombre del asesor a cargo (Carver, 03-11-2026).
 *
 * La instrucción ya estaba en el prompt (ver bloqueIdentidad en ai/agentLoop.ts), pero el modelo se la
 * saltaba justo en el caso más común: la persona responde «Más información» a la plantilla de Bitrix,
 * que cita «soy Valezka Hernández», y el bot daba por hecha la presentación. De 18 primeras respuestas
 * del 03-11, ninguna dijo el nombre. Por eso se asegura en código, sobre el texto final.
 */

const normalizar = (s: string) =>
  (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
const escapar = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mayuscula = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Un nombre de persona tal como lo escribe el modelo: una o dos palabras con mayúscula. */
const NOMBRE = '[A-ZÁÉÍÓÚÑ][\\p{L}]+(?:\\s[A-ZÁÉÍÓÚÑ][\\p{L}]+)?';

/**
 * Antepone «soy <asesor>» al texto si todavía no lo nombra, sin duplicar el saludo:
 *  - «¡Bienvenida, María Augusta! Le envié…» → la presentación va después de ese saludo;
 *  - «Hola Yolanda, le envié…» o «Yolanda, le envié…» → «Hola, Yolanda. Soy … » y el resto;
 *  - cualquier otro comienzo → «Hola, soy … » y el texto completo.
 * `cliente` (su nombre en el CRM) solo sirve para reconocer el vocativo: sin él, «Perfecto, le
 * cuento…» se tomaría por un nombre.
 */
export function asegurarPresentacion(texto: string, asesor: string, organizacion: string, cliente?: string): string {
  const t = (texto ?? '').trim();
  const nombre = (asesor ?? '').trim();
  const primero = normalizar(nombre.split(/\s+/)[0] ?? '');
  if (!t || !primero) return texto;
  if (new RegExp(`(^|[^\\p{L}])${escapar(primero)}([^\\p{L}]|$)`, 'u').test(normalizar(t))) return texto;

  const frase = `soy ${nombre} y le acompaño en su proceso de admisión en ${organizacion}.`;

  // Un saludo que es una frase propia: «¡Bienvenida, María Augusta!», «¡Hola!», «Buenas tardes, Luis.»
  const saludo = new RegExp(
    `^(¡?\\s*(?:[Hh]ola|[Bb]uen[oa]s\\s+(?:d[ií]as|tardes|noches)|[Bb]ienvenid[oa])(?:,?\\s+${NOMBRE})?\\s*[.!])\\s*`,
    'u',
  ).exec(t);
  if (saludo) return `${saludo[1]} ${mayuscula(frase)}\n\n${t.slice(saludo[0].length)}`.trim();

  // «Hola Yolanda, le envié…»: lo que sigue a «Hola» es su nombre.
  const conHola = new RegExp(`^¡?[Hh]ola,?\\s+(${NOMBRE}),\\s+`, 'u').exec(t);
  // «Yolanda, le envié…»: solo si es su nombre en el CRM.
  const nombreCliente = normalizar((cliente ?? '').trim().split(/\s+/)[0] ?? '');
  const vocativo = conHola ?? new RegExp(`^(${NOMBRE}),\\s+`, 'u').exec(t);
  if (vocativo && (conHola || (nombreCliente && normalizar(vocativo[1]).split(/\s+/)[0] === nombreCliente))) {
    return `Hola, ${vocativo[1]}. ${mayuscula(frase)}\n\n${mayuscula(t.slice(vocativo[0].length))}`;
  }

  return `Hola, ${frase}\n\n${t}`;
}
