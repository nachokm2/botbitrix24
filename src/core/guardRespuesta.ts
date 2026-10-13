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
  return /titulaci|graduaci|\bfee\b|costos? (adicional|extra)|cobros? (adicional|extra)|pagos? (adicional|extra)|otros? (costos?|cobros?|pagos?|gastos?)|algun (otro )?(costo|cobro|pago|gasto)|en total|total (a pagar|del programa|final|de todo)|todo incluido|que (mas|otro) (hay que|tengo que|debo) pagar|incluye todo|costo total|valor total|inscripci|retiro/.test(
    t,
  );
}

// Una frase que menciona el fee de titulación/graduación o el de retiro, con o sin monto. Se detecta
// por el concepto y no solo por el monto porque el modelo lo parafrasea ("al finalizar se paga el
// título", "derecho de grado").
const FRASE_FEE = /(titulaci[oó]n|graduaci[oó]n|derecho de grado|emisi[oó]n del t[ií]tulo)[^.\n]{0,80}(usd|us\$|\$|d[oó]lar|pag|cost|cobr|cuota)|(usd|us\$|\$)\s?125\b|\b125\s?(usd|d[oó]lares)|cuota de (procesamiento por )?retiro|retiro[^.\n]{0,30}(usd|us\$|\$)\s?35/i;

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
};

// Afirma que algo quedó registrado o derivado, en pasado o en futuro ("quedará registrado").
// Admite palabras en medio ("Quedé con sus datos anotados", dicho con el CRM caído en la regresión).
const AFIRMA_REGISTRO =
  // (Sin \b al final del verbo: en JavaScript \b no trata "é" ni "á" como letras, y "quedé" no calzaba.)
  /\b(qued[eéoó]|quedar[aá]n?|dej[eéo]|he dejado|tengo|ya (est[aá]n?|tengo|qued[oó]))(?![a-záéíóúñ])[^.!?\n]{0,40}\b(registrad|anotad|guardad|derivad)|registr[eé] (sus|tus) datos|lo registro|(lo|la) (he )?derivad[oa]|(lo|la) contactar[aá]n? a la brevedad/i;

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

  // 2b) Si el CRM falló en este turno, nada de "quedó registrado" ni "lo contactarán".
  if (ctx.crmFallo) {
    const partes = frases(texto);
    const honestas = partes.filter((f) => !AFIRMA_REGISTRO.test(f));
    if (honestas.length < partes.length && honestas.join(' ').trim()) {
      cambios.push('afirmacion_registro_fallido');
      texto = honestas.join(' ');
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
    const nuevas = partes.filter((f) => {
      const n = norm(f).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      return !(n.length >= 40 && previas.has(n));
    });
    if (nuevas.length < partes.length && nuevas.join(' ').trim()) {
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
