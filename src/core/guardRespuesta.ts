/**
 * Guardián de la respuesta: reglas comerciales que se IMPONEN sobre el texto antes de enviarlo, en
 * vez de confiar en que el modelo las recuerde.
 *
 * Nació de la auditoría del piloto de Carver. Cada una de estas reglas ya estaba en el prompt y el
 * modelo igual las rompía en producción:
 *  - mencionaba el fee de titulación (USD 125) en cada cotización, sin que nadie lo preguntara;
 *  - entregaba enlaces que no venían de ninguna verificación (un visor HTML de otra institución
 *    como "brochure");
 *  - usaba negritas de markdown, que en WhatsApp se leen como asteriscos sueltos;
 *  - repetía de un mensaje al siguiente la misma frase de cierre o el mismo bloque.
 * Un prompt orienta; una regla de negocio se hace cumplir en código. Esto es lo segundo.
 *
 * Es PURO (sin I/O): recibe el texto y el contexto del turno y devuelve el texto corregido más la
 * lista de cambios, para auditarlos. Si una corrección dejaría el mensaje vacío, no se aplica.
 */

const norm = (s: string) =>
  (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

/** ¿El cliente preguntó EXPLÍCITAMENTE por costos que no están en el arancel (titulación, total,
 *  costos adicionales)? Solo entonces se pueden mencionar. */
export function preguntaPorCostosAdicionales(mensaje: string): boolean {
  const t = norm(mensaje);
  // "Derechos de grado" es como se le dice a la titulación en varios países: la pregunta quedaba sin
  // responder porque la regla de abajo quitaba el monto (chat 1563451, 01-11-2026).
  return /titulaci|graduaci|\bfee\b|derechos? de grado|(costo|valor|precio|cobro) (del|de) (titulo|grado|diploma)|emision del titulo|costos? (adicional|extra)|cobros? (adicional|extra)|pagos? (adicional|extra)|otros? (costos?|cobros?|pagos?|gastos?)|algun (otro )?(costo|cobro|pago|gasto)|en total|total (a pagar|del programa|final|de todo)|todo incluido|que (mas|otro) (hay que|tengo que|debo) pagar|incluye todo|costo total|valor total|inscripci|retiro/.test(
    t,
  );
}

// Formas de tú y de vos que no aparecen cuando se trata de "usted". Quedan fuera las ambiguas
// ("estas" es también demostrativo; "mira" o "recuerda" pueden ser tercera persona): mejor dejar
// pasar un tuteo que reescribir un mensaje correcto. El infinitivo con "te" ("contarte",
// "conocerte", "inscribirte") excluye las palabras que terminan igual sin serlo: "imparte" y
// "comparte" (-parte), "invierte" y "convierte" (-ierte). "Ti" solo con preposición: también es un
// nombre ("¡Hola, Ti!").
const TUTEO =
  /\b(tu|tus|(?:para|a|de|en|por|sin|sobre) ti|contigo|tuyo|tuya|te|eres|tienes|puedes|quieres|necesitas|deseas|prefieres|sabes|buscas|piensas|crees|vas|haces|debes|podrias|tendrias|quisieras|tengas|puedas|quieras|cuentame|dime|escribeme|avisame|dejame|contame|tenes|queres|podes|sos|vos|[a-z]{2,}[a-oq-z]arte|[a-z]{2,}[a-hj-z]erte|[a-z]{3,}irte|[a-z]{3,}(ando|iendo)te)\b/g;

/** Las palabras que delatan tuteo o voseo en un texto, sin repetir. Vacío si trata de "usted".
 *  Carver: «Al graduarte puedes trabajar…» (chat 1570307, 03-11-2026), y 44 recordatorios en una semana. */
export function detectarTuteo(texto: string): string[] {
  const vistas = new Set<string>();
  for (const m of norm(texto).matchAll(TUTEO)) vistas.add(m[0]);
  return [...vistas];
}

// Una frase que menciona el fee de titulación/graduación o el de retiro, con o sin monto. Se detecta
// por el concepto y no solo por el monto porque el modelo lo parafrasea ("al finalizar se paga el
// título", "derecho de grado").
const FRASE_FEE = /(titulaci[oó]n|graduaci[oó]n|derecho de grado|emisi[oó]n del t[ií]tulo)[^.\n]{0,80}(usd|us\$|\$|d[oó]lar|pag|cost|cobr|cuota)|(usd|us\$|\$)\s?125\b|\b125\s?(usd|d[oó]lares)|cuota de (procesamiento por )?retiro|retiro[^.\n]{0,30}(usd|us\$|\$)\s?35/i;

/** ¿Preguntó cuánto cuesta la apostilla? Carver pidió decir que se puede gestionar a través de Carver
 *  sin dar el valor, salvo que lo pregunten (02-11-2026). */
export function preguntaCostoApostilla(mensaje: string): boolean {
  const t = norm(mensaje);
  return /apostill/.test(t) && /cuanto|cost|cuesta|valor|precio|vale|cobr|pag|monto|tarifa/.test(t);
}

const MONTO = /(usd|us\$|\$)\s?\d|\b\d[\d.,]*\s?(usd|d[oó]lares)/i;

const URL_RE = /https?:\/\/[^\s)\]>"'<]+/gi;

/** Divide en frases conservando los cortes de línea, para poder quitar una frase sin romper el resto. */
function frases(texto: string): string[] {
  return texto.split(/(?<=[.!?])[ \t]+|(?=\n)/);
}

const limpiarUrl = (u: string) => u.replace(/[.,;:]+$/, '');

export type ContextoGuard = {
  /** Mensaje del cliente en este turno. */
  mensajeCliente: string;
  /** Respuestas anteriores del bot en esta conversación (las más recientes al final). */
  respuestasPrevias: string[];
  /** Enlaces que el bot puede compartir en este turno: los que devolvieron las herramientas y los
   *  oficiales fijos de la marca. Cualquier otro se quita. */
  urlsPermitidas: string[];
  /** Largo a partir del cual el mensaje se considera excesivo para WhatsApp. */
  maxCaracteres: number;
  /** Una escritura al CRM (registro o derivación) FALLÓ en este turno: no se puede afirmar lo contrario. */
  crmFallo?: boolean;
  /** La derivación es interna: el bot habla como el asesor a cargo y no anuncia que pasó el caso a
   *  otro (ver DERIVACION_CARVER en core/promptObjeciones.ts). */
  derivacionInterna?: boolean;
};

// Anuncia una derivación: "lo he escalado al equipo de soporte", "un asesor lo contactará", "le
// conecto con un asesor". Se mira sobre el texto sin tildes.
const ANUNCIA_DERIVACION = new RegExp(
  [
    String.raw`\b(lo|la|le|se lo|se la)\s+(he\s+|hemos\s+)?(escalad[oa]|escale|derivad[oa]|derive|transferid[oa]|transferi|pasad[oa] al|pase al)\b`,
    String.raw`\b(he|hemos|ya)\s+(escalado|derivado|transferido)\b`,
    String.raw`\b(un|una|otro|otra|el|la|su|nuestro|nuestra)\s+(asesor|asesora|ejecutivo|ejecutiva|colega|especialista|equipo de soporte|equipo de admisiones|equipo de admision|area de admisiones|area de admision)\s+(lo|la|le|se)\s+(va a\s+|podra\s+)?(contact|confirm|escrib|llam|comunic|respond)`,
    String.raw`\b(conectarl[oea]|le conecto|lo conecto|la conecto|ponerl[oea] en contacto|l[oea] pongo en contacto|comunicarl[oea] con|derivarl[oea]|escalarl[oea])\b`,
  ].join('|'),
);

/** Lo que dice el asesor a cargo en vez de anunciar la derivación. */
export const COMPROMISO_EN_PRIMERA_PERSONA = 'Lo reviso con el área que corresponde y le respondo por este medio.';

// Afirma que algo quedó registrado o derivado, en pasado o en futuro ("quedará registrado").
// Admite palabras en medio ("Quedé con sus datos anotados", dicho con el CRM caído en la regresión).
const AFIRMA_REGISTRO =
  // (Sin \b al final del verbo: en JavaScript \b no trata "é" ni "á" como letras, y "quedé" no calzaba.)
  /\b(qued[eéoó]|quedar[aá]n?|dej[eéo]|he dejado|tengo|ya (est[aá]n?|tengo|qued[oó]))(?![a-záéíóúñ])[^.!?\n]{0,40}\b(registrad|anotad|guardad|derivad)|registr[eé] (sus|tus) datos|lo registro|(lo|la) (he )?derivad[oa]|(lo|la) contactar[aá]n? a la brevedad/i;

// Dice que el título viene con la apostilla. Se mira sobre el texto sin tildes. «Gestiona la apostilla»
// (la plantilla aprobada) no calza: no dice que venga incluida.
const TITULO_CON_APOSTILLA =
  /\b(titulos?|diplomas?|documentos?|transcript)\b[^.!?\n]{0,60}(\bcon (la )?apostilla\b|\bapostillad[oa]s?\b)|\bapostilla (de la haya )?(ya )?(esta |va |viene )?incluida\b|\bincluye (la )?apostilla\b/;
// Lo dice bien: lo niega, o lo plantea como algo que se pide aparte («si necesita los documentos físicos
// apostillados, la universidad le apoya», que es el texto del panel).
const APOSTILLA_BIEN_DICHA =
  /\bno (vienen?|van|incluye|incluyen|esta|estan|se entregan?|salen?|llevan?)\b|\bsin (la )?apostilla\b|\bno [^.!?\n]{0,25}apostillad|\bsi (lo |la |los |las )?(necesita|requiere|quiere|desea)|\bpuede (pedir|solicitar|gestionar)|\baparte\b/;
// Dice que el título se entrega en papel, sin decir que es digital y que el físico se pide aparte.
const TITULO_EN_FISICO = /\b(titulo|diploma)\b[^.!?\n]{0,50}\b(en |formato )fisico\b/;
const FISICO_BIEN_DICHO = /digital|pedir|solicitar|a pedido|aparte|adicional|\bsi (lo |la )?(necesita|requiere|quiere|desea)/;
export const CORRECCION_APOSTILLA = 'La apostilla de La Haya no viene incluida: es un trámite aparte, que puede gestionar a través de Carver.';
export const CORRECCION_FISICO = 'El título y el registro de calificaciones se entregan en formato digital, y se pueden pedir en físico.';

export type ResultadoGuard = { texto: string; cambios: string[]; excedeLargo: boolean };

export function guardarRespuesta(textoOriginal: string, ctx: ContextoGuard): ResultadoGuard {
  const cambios: string[] = [];
  let texto = textoOriginal ?? '';
  if (!texto.trim()) return { texto, cambios, excedeLargo: false };

  // 1) Formato WhatsApp: sin negritas ni títulos de markdown.
  const sinMarkdown = texto
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '');
  if (sinMarkdown !== texto) {
    cambios.push('markdown');
    texto = sinMarkdown;
  }

  // 2) Fee de titulación (y de retiro) solo ante una pregunta explícita.
  if (!preguntaPorCostosAdicionales(ctx.mensajeCliente)) {
    const partes = frases(texto);
    const sinFee = partes.filter((f) => !FRASE_FEE.test(f));
    if (sinFee.length < partes.length && sinFee.join(' ').trim()) {
      cambios.push('fee_no_solicitado');
      texto = sinFee.join(' ');
    }
  }

  // 2a) El valor de la apostilla, solo si preguntaron cuánto cuesta. Se mira la frase que la nombra y
  // la siguiente, porque el monto suele ir aparte ("Se gestiona a través de Carver. Tiene un valor de…").
  if (!preguntaCostoApostilla(ctx.mensajeCliente)) {
    const partes = frases(texto);
    const anterior = (i: number) => partes.slice(0, i).reverse().find((p) => p.trim()) ?? '';
    const sinMonto = partes.filter((f, i) => !(MONTO.test(f) && (/apostill/i.test(f) || /apostill/i.test(anterior(i)))));
    if (sinMonto.length < partes.length && sinMonto.join(' ').trim()) {
      cambios.push('apostilla_no_solicitada');
      texto = sinMonto.join(' ');
    }
  }

  // 2b) Si el CRM falló en este turno, nada de "quedó registrado" ni "lo contactarán".
  if (ctx.crmFallo) {
    const partes = frases(texto);
    const honestas = partes.filter((f) => !AFIRMA_REGISTRO.test(f));
    if (honestas.length < partes.length && honestas.join(' ').trim()) {
      cambios.push('afirmacion_registro_fallido');
      texto = honestas.join(' ');
    }
  }

  // 2c) La derivación no se anuncia. Estaba en el prompt y aun así salió "Jimena, lo he escalado al
  // equipo de soporte" (chat 1383805, 31-10-2026). La primera frase que la anuncia se cambia por el
  // compromiso en primera persona; si hay más, se quitan.
  if (ctx.derivacionInterna) {
    const nuevas: string[] = [];
    let reemplazada = false;
    for (const f of frases(texto)) {
      if (!ANUNCIA_DERIVACION.test(norm(f))) {
        nuevas.push(f);
      } else if (!reemplazada) {
        nuevas.push(f.startsWith('\n') ? `\n${COMPROMISO_EN_PRIMERA_PERSONA}` : COMPROMISO_EN_PRIMERA_PERSONA);
        reemplazada = true;
      }
    }
    if (reemplazada) {
      cambios.push('derivacion_anunciada');
      texto = nuevas.join(' ');
    }
  }

  // 2d) El título no viene apostillado ni se entrega en papel. Estaba en el prompt y aun así salió
  // «Carver entrega el título con apostilla» (chat 1599245) y «El título se obtiene en formato físico»
  // (chat 1586329), entre el 09 y el 13-11-2026. La frase se cambia por la correcta.
  {
    let tocada = false;
    // Se mira cada parte de la frase por separado: en «El título se obtiene en formato físico; la
    // apostilla es trámite aparte» el «aparte» es de la segunda parte, no de la primera.
    const partesDe = (f: string) => norm(f).split(/[;:]/);
    const nuevas = frases(texto).map((f) => {
      const partes = partesDe(f);
      const corregida = partes.some((n) => TITULO_CON_APOSTILLA.test(n) && !APOSTILLA_BIEN_DICHA.test(n))
        ? CORRECCION_APOSTILLA
        : partes.some((n) => TITULO_EN_FISICO.test(n) && !FISICO_BIEN_DICHO.test(n))
          ? CORRECCION_FISICO
          : null;
      if (!corregida) return f;
      tocada = true;
      return f.startsWith('\n') ? `\n${corregida}` : corregida;
    });
    if (tocada) {
      cambios.push('titulo_apostilla_o_fisico');
      // Si dos frases quedaron iguales (las dos decían lo mismo), sale una sola.
      texto = nuevas.filter((f, i) => f.trim() !== nuevas[i - 1]?.trim()).join(' ');
    }
  }

  // 3) Enlaces: solo los verificados en este turno o los oficiales fijos.
  const permitidas = new Set(ctx.urlsPermitidas.map(limpiarUrl));
  const encontradas = (texto.match(URL_RE) ?? []).map(limpiarUrl);
  const noPermitidas = encontradas.filter((u) => !permitidas.has(u));
  if (noPermitidas.length) {
    let t = texto;
    for (const u of noPermitidas) t = t.split(u).join('');
    // Una frase que solo presentaba el enlace ("Aquí tiene el brochure:") queda sin sentido: se quita.
    const partes = frases(t).filter((f) => !/^\s*(aqu[ií]|ac[aá]) (tiene|le (dejo|comparto|env[ií]o))[^.!?\n]*:?\s*$/i.test(f));
    const candidato = partes.join(' ').replace(/\[URL\]\s*\[\/URL\]/gi, '');
    if (candidato.trim()) {
      cambios.push('url_no_verificada');
      texto = candidato;
    }
  }

  // 4) Repeticiones: una frase larga idéntica a otra de los últimos mensajes no aporta nada.
  const previas = new Set(
    ctx.respuestasPrevias
      .slice(-3)
      .flatMap((r) => frases(r))
      .map((f) => norm(f).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim())
      .filter((f) => f.length >= 40),
  );
  if (previas.size) {
    const partes = frases(texto);
    const repetida = partes.map((f) => {
      const n = norm(f).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      return n.length >= 40 && previas.has(n);
    });
    const nuevas = partes.filter((_, i) => !repetida[i]);
    // Una lista no se quita a medias: su presentación quedaría colgando sin nada después. Pasó con
    // «los valores aproximados en pesos chilenos son:» y ningún valor (chat 1562063, 31-10-2026).
    // Repetir la lista es mejor que dejar al cliente sin ella.
    const siguienteConTexto = (i: number) => partes.findIndex((f, j) => j > i && f.trim() !== '');
    const dejaPresentacionSola = partes.some((f, i) => {
      if (repetida[i] || !/:\s*$/.test(f)) return false;
      const sig = siguienteConTexto(i);
      return sig >= 0 && repetida[sig];
    });
    if (nuevas.length < partes.length && nuevas.join(' ').trim() && !dejaPresentacionSola) {
      cambios.push('repeticion');
      texto = nuevas.join(' ');
    }
  }

  texto = texto
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  return { texto, cambios, excedeLargo: texto.length > ctx.maxCaracteres };
}

/** Todos los enlaces que aparecen en un valor arbitrario (resultado de herramienta). */
export function urlsEn(valor: unknown): string[] {
  const s = typeof valor === 'string' ? valor : JSON.stringify(valor ?? '');
  return (s.match(URL_RE) ?? []).map(limpiarUrl);
}
