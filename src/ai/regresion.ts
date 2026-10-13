/**
 * Suite de regresión sobre conversaciones reales.
 *
 * Cada defecto que se corrigió durante el piloto salió de una conversación concreta: el bot que
 * seguía pidiendo el nombre, el que no dio información de psicología, el mensaje de dos pantallas,
 * el que no actualizó el programa cuando la conversación cambió de rumbo. Cada arreglo fue a un
 * prompt que después se volvió a tocar muchas veces, sin nada que avisara si se rompía de nuevo.
 *
 * Esto convierte esos casos en comprobaciones. No se compara texto exacto —el modelo nunca contesta
 * dos veces igual y una prueba así sería inútil a la semana— sino PROPIEDADES de la respuesta: que
 * no vuelva a pedir un dato que ya tiene, que no invente un precio sin consultar la planilla, que
 * derive cuando se lo piden, que no se extienda más de la cuenta.
 *
 * El motor es agnóstico del modelo: recibe la función que ejecuta un turno, así que las pruebas
 * unitarias lo corren con un doble y scripts/regresion.ts lo corre contra el bot de verdad.
 */

export type LlamadaHerramienta = { name: string; input?: any; resultado?: any };
export type TurnoEjecutado = { mensaje: string; respuesta: string; tools: LlamadaHerramienta[] };

export type Comprobacion =
  | { tipo: 'no_pide_dato'; dato: 'nombre' | 'email' | 'telefono' }
  | { tipo: 'no_respuesta_vacia' }
  | { tipo: 'deriva' }
  | { tipo: 'no_deriva' }
  | { tipo: 'precio_viene_de_la_planilla' }
  | { tipo: 'no_ofrece_llamada' }
  | { tipo: 'menciona'; texto: string }
  | { tipo: 'no_menciona'; texto: string }
  | { tipo: 'programa_de_interes'; programa: string }
  | { tipo: 'largo_maximo'; caracteres: number }
  // Comprobaciones agregadas en la auditoría del piloto de Carver (ver docs/AUDITORIA-CARVER.md).
  | { tipo: 'fee_solo_si_preguntan' }
  | { tipo: 'no_ofrece_nooc' }
  | { tipo: 'brochure_verificado' }
  | { tipo: 'sin_markdown' }
  | { tipo: 'preguntas_por_respuesta'; maximo: number }
  | { tipo: 'no_pregunta_modalidad' }
  | { tipo: 'no_repite' }
  | { tipo: 'identidad_coherente'; nombre?: string }
  | { tipo: 'no_inventa_fechas' }
  | { tipo: 'no_afirma_registro_fallido' };

/** Estado simulado del CRM para un caso: lo que el bot "ya sabe" al empezar y cómo responde el CRM. */
export type ContextoCaso = {
  datosConocidos?: { nombre?: string; email?: string; telefono?: string };
  identidadAsesor?: { nombre: string; email?: string } | null;
  /** Resultado que devuelve consultar_estado_estudiante en este caso. */
  estudiante?: any;
  /** Simula Bitrix caído: las herramientas que escriben en el CRM fallan. */
  crmCaido?: boolean;
};

export type CasoRegresion = {
  nombre: string;
  /** De dónde salió: la conversación real que motivó la comprobación. */
  origen?: string;
  mensajes: string[];
  comprobaciones: Comprobacion[];
  contexto?: ContextoCaso;
};

export type ResultadoCaso = {
  nombre: string;
  ok: boolean;
  fallas: string[];
  turnos: TurnoEjecutado[];
  /** Cuántas comprobaciones tenía el caso: el denominador del cumplimiento de reglas. */
  comprobaciones?: number;
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

// Formas en que se pide cada dato. Van sobre el texto normalizado (sin tildes, en minúscula).
const PIDE: Record<string, RegExp> = {
  nombre: /\b(tu|su|me (das|dices|indicas|facilitas)|cual es (tu|su))\s*(nombre|como te llamas)|como te llamas|con quien tengo el gusto/,
  email: /\b(correo|email|e-mail|mail)\b[^?.]{0,40}\?|\b(tu|su) (correo|email|mail)\b/,
  telefono: /\b(telefono|numero de contacto|numero telefonico|whatsapp)\b[^?.]{0,40}\?|\b(tu|su) (telefono|numero)\b/,
};

// Un precio en el texto: $ con miles, "USD 1.200", "1.200.000 pesos". Sirve para detectar que el bot
// afirmó un valor; si lo hizo sin pasar por la planilla, se lo inventó.
const PARECE_PRECIO = /(\$\s?\d|usd\s?\d|\d[\d.,]{3,}\s?(pesos|dolares|clp|usd))/i;

const OFRECE_LLAMADA = /\b(te llamo|lo llamo|llamarte|llamarlo|una llamada|coordinar una llamada|te marco|llamada telefonica)\b/;

// Las expresiones de abajo son a propósito INDEPENDIENTES de las que usa el bot para imponer las
// mismas reglas (core/guardRespuesta.ts): si compartieran el código, un error en la regla pasaría
// también el examen.

// El cliente pregunta de forma explícita por costos que no están en el arancel.
const PREGUNTA_COSTOS = /titulaci|graduaci|costos? adicional|otros (costos|cobros|pagos)|algun otro (costo|cobro|pago)|en total|total a pagar|todo incluido|que mas (hay que|tengo que) pagar/;
// La respuesta menciona el fee de titulación con un monto.
const MENCIONA_FEE = /(titulaci[oó]n|graduaci[oó]n)[^.\n]{0,60}(usd|us\$|\$)\s?\d|(usd|us\$|\$)\s?125[^.\n]{0,40}(titulaci|graduaci)|125 (usd|d[oó]lares)[^.\n]{0,40}(titulaci|graduaci)/i;
// Ofrecer un NOOC: hablar de cursos gratuitos, del certificado de USD 20, o nombrar un NOOC del catálogo.
const OFRECE_NOOC = /(gratis|gratuit[oa]s?|sin costo)[^.\n]{0,80}\b(curso|nooc)|\b(curso|nooc)s?\b[^.\n]{0,80}(gratis|gratuit|sin costo)|certificado[^.\n]{0,40}(usd|us\$|\$)\s?20\b/i;
const NOMBRES_NOOC = [
  'hacking etico',
  'personal branding',
  'envejecimiento y demencia',
  'finanzas y bienestar personal',
  'urgencias en salud mental',
  'competencias digitales para educadores',
  'funciones y modulos de python',
];
const URL = /https?:\/\/[^\s)\]>"']+/gi;
const MARKDOWN = /\*\*[^*\n]+\*\*|^#{1,6}\s/m;
const PREGUNTA_MODALIDAD = /(modalidad|presencial|semipresencial|online o|en linea o|virtual o)[^?¿]{0,80}\?/;
const FECHA_CON_DIA = /\b\d{1,2}\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b|\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\s+\d{1,2}\b/;
// Incluye el futuro ("quedará registrado"): la primera corrida DESPUÉS lo dejó pasar.
const AFIRMA_REGISTRO = /\b(qued[eo]|quedar[a]n?|dej[eo]|he dejado|tengo|ya (estan?|tengo|quedo))\b[^.!?\n]{0,40}\b(registrad|anotad|guardad|derivad)|registr[e] (sus|tus) datos|lo registro|lo (he )?derivad[oa]/;
// Hablando COMO el asesor, remitir a "un asesor" suena a que hay otro (regresión R09).
const REMITE_A_OTRO_ASESOR = /\b(un|otro|algun) asesor[a]? (le |lo |la )?(confirm|contact|llam|escrib|respond|indic)|confirmar(le|selo|lo) un asesor|lo confirma un asesor|que (le|lo|la) (contacte|confirme) un asesor/;
const SE_DICE_BOT = /asistente virtual|soy (un|una) (bot|ia|inteligencia artificial)|como (ia|inteligencia artificial)/;

/** Oraciones "con contenido" de un texto, normalizadas, para detectar repeticiones entre mensajes. */
function oraciones(texto: string): string[] {
  return norm(texto)
    .split(/[.!?\n]+/)
    .map((s) => s.replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 30);
}

function urlsDe(texto: string): string[] {
  return (texto.match(URL) ?? []).map((u) => u.replace(/[.,;]+$/, ''));
}

function evaluar(c: Comprobacion, turnos: TurnoEjecutado[]): string | null {
  const respuestas = turnos.map((t) => t.respuesta);
  const tools = turnos.flatMap((t) => t.tools);

  switch (c.tipo) {
    case 'no_pide_dato': {
      const i = respuestas.findIndex((r) => PIDE[c.dato].test(norm(r)));
      return i >= 0 ? `volvió a pedir ${c.dato} en el turno ${i + 1}: "${recorte(respuestas[i])}"` : null;
    }
    case 'no_respuesta_vacia': {
      const i = respuestas.findIndex((r) => !r || !r.trim());
      return i >= 0 ? `respuesta vacía en el turno ${i + 1}` : null;
    }
    case 'deriva':
      return tools.some((t) => t.name === 'escalar_a_humano') ? null : 'no derivó a un asesor';
    case 'no_deriva':
      return tools.some((t) => t.name === 'escalar_a_humano') ? 'derivó cuando no correspondía' : null;
    case 'precio_viene_de_la_planilla': {
      // Se recorre en orden: un precio solo vale si ANTES se consultó la planilla. Mirar únicamente
      // "¿se llamó la herramienta en algún momento?" dejaría pasar un precio inventado al principio.
      let consultada = false;
      for (const t of turnos) {
        if (t.tools.some((x) => x.name === 'consultar_condiciones_comerciales')) consultada = true;
        if (!consultada && PARECE_PRECIO.test(t.respuesta)) {
          return `dio un precio sin consultar la planilla: "${recorte(t.respuesta)}"`;
        }
      }
      return null;
    }
    case 'no_ofrece_llamada': {
      const i = respuestas.findIndex((r) => OFRECE_LLAMADA.test(norm(r)));
      return i >= 0 ? `ofreció una llamada en el turno ${i + 1}: "${recorte(respuestas[i])}"` : null;
    }
    case 'menciona':
      return respuestas.some((r) => norm(r).includes(norm(c.texto))) ? null : `nunca mencionó "${c.texto}"`;
    case 'programa_de_interes': {
      // Importa con cuál se QUEDA la ficha, no por qué camino llegó: el bot puede escribirlo con
      // registrar_interes_crm, y pedir el detalle o el precio de un programa también lo fija (ver
      // seguirProgramaDeInteres en ai/toolRunner.ts). El defecto que esto vigila es que la ficha se
      // quede con el PRIMER programa nombrado aunque la conversación gire sobre otro, así que lo
      // que se compara es el ÚLTIMO.
      const mencionados = tools
        .map((t) =>
          t.name === 'registrar_interes_crm'
            ? t.input?.programa_interes
            : t.name === 'detalle_programa'
              ? t.input?.nombre
              : t.name === 'consultar_condiciones_comerciales'
                ? t.input?.programa
                : null,
        )
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
      if (!mencionados.length) return `nunca fijó un programa de interés (esperaba "${c.programa}")`;
      const ultimo = mencionados[mencionados.length - 1];
      return norm(ultimo).includes(norm(c.programa))
        ? null
        : `la ficha se quedó con "${ultimo}" en vez de "${c.programa}"`;
    }
    case 'largo_maximo': {
      const i = respuestas.findIndex((r) => r.length > c.caracteres);
      return i >= 0 ? `respuesta de ${respuestas[i].length} caracteres en el turno ${i + 1} (máximo ${c.caracteres})` : null;
    }
    case 'no_menciona': {
      const i = respuestas.findIndex((r) => norm(r).includes(norm(c.texto)));
      return i >= 0 ? `mencionó "${c.texto}" en el turno ${i + 1}: "${recorte(respuestas[i])}"` : null;
    }
    case 'fee_solo_si_preguntan': {
      for (let i = 0; i < turnos.length; i++) {
        const preguntado = PREGUNTA_COSTOS.test(norm(turnos[i].mensaje));
        if (!preguntado && MENCIONA_FEE.test(turnos[i].respuesta)) {
          return `mencionó el fee de titulación sin que lo preguntaran (turno ${i + 1}): "${recorte(turnos[i].respuesta)}"`;
        }
      }
      return null;
    }
    case 'no_ofrece_nooc': {
      // Ofrecer y declinar usan las mismas palabras ("no tenemos cursos gratis"): una frase con
      // negación no es una oferta, y un nombre que trajo el propio cliente puede repetirse al declinar.
      const NIEGA = /\bno\b|ningun|tampoco|fuera de|no forma parte|no estan disponibles/;
      for (let i = 0; i < turnos.length; i++) {
        const frases = turnos[i].respuesta.split(/(?<=[.!?\n])/);
        const oferta = frases.find((f) => OFRECE_NOOC.test(f) && !NIEGA.test(norm(f)));
        if (oferta) return `ofreció un NOOC o curso gratuito (turno ${i + 1}): "${recorte(oferta)}"`;
        const delCliente = norm(turnos[i].mensaje);
        const nombre = NOMBRES_NOOC.find(
          (n) => !delCliente.includes(n) && frases.some((f) => norm(f).includes(n) && !NIEGA.test(norm(f))),
        );
        if (nombre) return `nombró el NOOC "${nombre}" (turno ${i + 1})`;
      }
      return null;
    }
    case 'brochure_verificado': {
      // Un enlace entregado como brochure tiene que venir de la verificación de ESE turno: que la
      // herramienta lo haya comprobado accesible. Un enlace copiado del catálogo sin comprobar es
      // justamente el defecto observado (un visor HTML en el dominio de otra institución).
      for (let i = 0; i < turnos.length; i++) {
        const t = turnos[i];
        const urls = urlsDe(t.respuesta);
        const hablaDeBrochure = /brochure|folleto|\bpdf\b/.test(norm(t.respuesta));
        if (!urls.length || !hablaDeBrochure) continue;
        const verificadas = t.tools
          .filter((x) => x.name === 'obtener_brochure' && x.resultado?.ok === true)
          .map((x) => String(x.resultado?.url ?? ''));
        const sinVerificar = urls.filter((u) => !verificadas.includes(u));
        if (sinVerificar.length) return `entregó un enlace de brochure sin verificar (turno ${i + 1}): ${sinVerificar[0]}`;
      }
      return null;
    }
    case 'sin_markdown': {
      const i = respuestas.findIndex((r) => MARKDOWN.test(r));
      return i >= 0 ? `usó formato markdown en el turno ${i + 1}: "${recorte(respuestas[i])}"` : null;
    }
    case 'preguntas_por_respuesta': {
      const i = respuestas.findIndex((r) => (r.match(/\?/g) ?? []).length > c.maximo);
      return i >= 0 ? `hizo ${(respuestas[i].match(/\?/g) ?? []).length} preguntas en el turno ${i + 1} (máximo ${c.maximo})` : null;
    }
    case 'no_pregunta_modalidad': {
      const i = respuestas.findIndex((r) => PREGUNTA_MODALIDAD.test(norm(r)));
      return i >= 0 ? `preguntó por la modalidad, que no aplica (turno ${i + 1}): "${recorte(respuestas[i])}"` : null;
    }
    case 'no_repite': {
      const vistas = new Map<string, number>();
      for (let i = 0; i < respuestas.length; i++) {
        for (const o of new Set(oraciones(respuestas[i]))) {
          if (vistas.has(o)) return `repitió en el turno ${i + 1} una frase del turno ${vistas.get(o)! + 1}: "${recorte(o)}"`;
          vistas.set(o, i);
        }
      }
      return null;
    }
    case 'identidad_coherente': {
      const nombre = c.nombre ? norm(c.nombre) : '';
      const primerNombre = nombre.split(/\s+/)[0] ?? '';
      for (let i = 0; i < respuestas.length; i++) {
        const r = norm(respuestas[i]);
        if (/\bsofia\b/.test(r) && primerNombre !== 'sofia') return `se presentó o habló como "Sofía" (turno ${i + 1})`;
        if (SE_DICE_BOT.test(r)) return `dijo ser un asistente virtual (turno ${i + 1})`;
        if (primerNombre) {
          const terceraPersona = new RegExp(
            `\\b(con|a|de|por|que|asesora?|ejecutiva?|colega)\\s+${primerNombre}\\b|\\b${primerNombre}\\b[^.?!]{0,40}\\b(lo|la|le)\\s+(contactara|llamara|escribira)`,
          );
          if (terceraPersona.test(r)) return `habló de "${c.nombre}" en tercera persona siendo esa persona (turno ${i + 1})`;
          if (REMITE_A_OTRO_ASESOR.test(r)) return `siendo el asesor, remitió a "un asesor" (turno ${i + 1}): "${recorte(respuestas[i])}"`;
        }
      }
      return null;
    }
    case 'no_inventa_fechas': {
      for (let i = 0; i < turnos.length; i++) {
        const m = norm(turnos[i].respuesta).match(FECHA_CON_DIA);
        if (!m) continue;
        const enHerramientas = norm(JSON.stringify(turnos[i].tools.map((x) => x.resultado ?? null)));
        if (!enHerramientas.includes(m[0])) return `afirmó una fecha que ninguna herramienta entregó (turno ${i + 1}): "${m[0]}"`;
      }
      return null;
    }
    case 'no_afirma_registro_fallido': {
      for (let i = 0; i < turnos.length; i++) {
        const fallo = turnos[i].tools.some(
          (x) => (x.name === 'registrar_interes_crm' || x.name === 'escalar_a_humano') && x.resultado?.ok === false,
        );
        if (fallo && AFIRMA_REGISTRO.test(norm(turnos[i].respuesta))) {
          return `afirmó haber registrado/derivado cuando el CRM falló (turno ${i + 1}): "${recorte(turnos[i].respuesta)}"`;
        }
      }
      return null;
    }
  }
}

/**
 * Métricas de calidad conversacional de una corrida. Sirven para COMPARAR dos corridas en las mismas
 * condiciones (mismos casos, mismo modelo); no son una nota absoluta. Una respuesta más corta no es
 * mejor por sí sola: por eso se reportan junto al cumplimiento de reglas y la resolución.
 */
export function metricas(resultados: ResultadoCaso[]) {
  const respuestas = resultados.flatMap((r) => r.turnos.map((t) => t.respuesta));
  const largos = respuestas.map((r) => r.length).sort((a, b) => a - b);
  const pct = (p: number) => (largos.length ? largos[Math.min(largos.length - 1, Math.floor(p * largos.length))] : 0);
  let oracionesTotales = 0;
  let repetidas = 0;
  for (const r of resultados) {
    const vistas = new Set<string>();
    for (const t of r.turnos) {
      for (const o of new Set(oraciones(t.respuesta))) {
        oracionesTotales++;
        if (vistas.has(o)) repetidas++;
        vistas.add(o);
      }
    }
  }
  const preguntas = respuestas.map((r) => (r.match(/\?/g) ?? []).length);
  const preguntasDeMas = preguntas.reduce((s, n) => s + Math.max(0, n - 1), 0);
  const comprobaciones = resultados.reduce((s, r) => s + (r.comprobaciones ?? 0), 0);
  const fallas = resultados.reduce((s, r) => s + r.fallas.length, 0);
  return {
    casos: resultados.length,
    respuestas: respuestas.length,
    largoMediano: pct(0.5),
    largoP90: pct(0.9),
    largoMaximo: largos[largos.length - 1] ?? 0,
    frecuenciaRepeticion: oracionesTotales ? repetidas / oracionesTotales : 0,
    preguntasInnecesarias: preguntasDeMas,
    comprobaciones,
    comprobacionesCumplidas: comprobaciones - fallas,
    cumplimiento: comprobaciones ? (comprobaciones - fallas) / comprobaciones : 1,
    casosAprobados: resultados.filter((r) => r.ok).length,
  };
}

const recorte = (s: string) => (s.length > 90 ? s.slice(0, 90) + '…' : s).replace(/\s+/g, ' ');

/** Corre un caso: ejecuta sus mensajes en orden y evalúa las comprobaciones sobre lo que salió. */
export async function ejecutarCaso(
  caso: CasoRegresion,
  ejecutarTurno: (mensaje: string) => Promise<{ respuesta: string; tools: LlamadaHerramienta[] }>,
): Promise<ResultadoCaso> {
  const turnos: TurnoEjecutado[] = [];
  for (const mensaje of caso.mensajes) {
    const r = await ejecutarTurno(mensaje);
    turnos.push({ mensaje, respuesta: r.respuesta ?? '', tools: r.tools ?? [] });
  }
  const fallas = caso.comprobaciones.map((c) => evaluar(c, turnos)).filter((x): x is string => x !== null);
  return { nombre: caso.nombre, ok: fallas.length === 0, fallas, turnos, comprobaciones: caso.comprobaciones.length };
}

/** Informe de una corrida completa, en texto plano para leerlo en la consola. */
export function informe(resultados: ResultadoCaso[]): string {
  const fallidos = resultados.filter((r) => !r.ok);
  const l = [`${resultados.length - fallidos.length}/${resultados.length} casos pasaron.`];
  for (const r of fallidos) {
    l.push(`\n✗ ${r.nombre}`);
    for (const f of r.fallas) l.push(`   · ${f}`);
  }
  return l.join('\n');
}
