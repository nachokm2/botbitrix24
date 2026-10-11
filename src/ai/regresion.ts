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

export type LlamadaHerramienta = { name: string; input?: any };
export type TurnoEjecutado = { mensaje: string; respuesta: string; tools: LlamadaHerramienta[] };

export type Comprobacion =
  | { tipo: 'no_pide_dato'; dato: 'nombre' | 'email' | 'telefono' }
  | { tipo: 'no_respuesta_vacia' }
  | { tipo: 'deriva' }
  | { tipo: 'no_deriva' }
  | { tipo: 'precio_viene_de_la_planilla' }
  | { tipo: 'no_ofrece_llamada' }
  | { tipo: 'menciona'; texto: string }
  | { tipo: 'programa_de_interes'; programa: string }
  | { tipo: 'largo_maximo'; caracteres: number };

export type CasoRegresion = {
  nombre: string;
  /** De dónde salió: la conversación real que motivó la comprobación. */
  origen?: string;
  mensajes: string[];
  comprobaciones: Comprobacion[];
};

export type ResultadoCaso = { nombre: string; ok: boolean; fallas: string[]; turnos: TurnoEjecutado[] };

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
  }
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
  return { nombre: caso.nombre, ok: fallas.length === 0, fallas, turnos };
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
