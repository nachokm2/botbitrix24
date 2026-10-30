import { marca } from '../marca';
import {
  PLANTILLA_TITULO_DEFECTO,
  DEVOLUCION_DEFECTO,
  INCLUYE_DEFECTO,
  OBJECIONES_FRECUENTES_DEFECTO,
  COSTOS_ADICIONALES_DEFECTO,
  costosAdicionalesTexto,
  devolucionTexto,
  type CostosAdicionales,
} from './promptObjeciones';
// Solo tipos: en ejecución este módulo no depende de ajustes.ts, que es el que lo usa a él.
import type { ErrorCampo, Validacion } from './ajustes';

/**
 * Sección "Comportamiento" del panel de configuración (ver core/ajustes.ts): los bloques del prompt que
 * el equipo puede editar sin tocar las reglas.
 *
 * Son contenido, no reglas: la plantilla de validez del título (la de admisión), qué incluye el programa,
 * la política de devolución y cómo responder las objeciones frecuentes. Lo que no se edita —identidad,
 * precios solo desde herramientas, enlaces de pago, acreditación, derivación invisible— queda fijo en el
 * código. El tono y el inicio de la conversación tampoco se abren por ahora: tocan cada mensaje y cada
 * frase salió de un problema real.
 *
 * Cómo se aplica: los textos de siempre están en core/promptObjeciones.ts y forman parte del prompt ya
 * armado. Lo publicado se REEMPLAZA sobre ese texto en cada turno (promptConAjustes). Sin cambios, el
 * prompt queda byte a byte igual, y con él la caché de Anthropic.
 */

export type AjustesComportamiento = {
  plantillaTitulo: string;
  incluyePrograma: string;
  politicaDevolucion: string;
  objecionesFrecuentes: string;
};

type DefBloque = { clave: keyof AjustesComportamiento; max: number; marcadores: string[]; obligatorios: string[] };

const BLOQUES: DefBloque[] = [
  { clave: 'plantillaTitulo', max: 800, marcadores: ['{país}', '{entidad}'], obligatorios: ['{país}', '{entidad}'] },
  { clave: 'incluyePrograma', max: 500, marcadores: [], obligatorios: [] },
  { clave: 'politicaDevolucion', max: 1600, marcadores: ['{inscripcion}'], obligatorios: [] },
  { clave: 'objecionesFrecuentes', max: 1600, marcadores: [], obligatorios: [] },
];

/** Hay bloques editables solo donde el prompt los tiene (hoy, Carver). */
export const comportamientoDisponible = () => marca.key === 'carver';

export function comportamientoPorDefecto(): AjustesComportamiento {
  return {
    plantillaTitulo: PLANTILLA_TITULO_DEFECTO,
    incluyePrograma: INCLUYE_DEFECTO,
    politicaDevolucion: DEVOLUCION_DEFECTO,
    objecionesFrecuentes: OBJECIONES_FRECUENTES_DEFECTO,
  };
}

// Un monto escrito a mano en un bloque se diría tal cual, aunque Precios diga otra cosa: los montos
// salen siempre de las herramientas o de la sección Precios.
const MONTO = /(usd|us\$|\$|dólares?|dolares?)\s*\d|\d[\d.,]*\s*(usd|dólares?|dolares?)\b/i;
const ENLACE = /https?:\/\/|www\./i;

// Los mensajes los lee alguien que no programa: dicen qué corregir, no qué regla se violó.
export function validarComportamiento(entrada: unknown): Validacion<AjustesComportamiento> {
  const x = (entrada && typeof entrada === 'object' && !Array.isArray(entrada) ? entrada : {}) as Record<string, unknown>;
  const defecto = comportamientoPorDefecto();
  const errores: ErrorCampo[] = [];
  const valor = { ...defecto };
  for (const b of BLOQUES) {
    const texto = String(x[b.clave] ?? defecto[b.clave]).replace(/\r\n/g, '\n').trim();
    const error = (mensaje: string) => errores.push({ campo: b.clave, mensaje });
    if (!texto) error('Escribe el texto, o vuelve al original.');
    if (texto.length > b.max) error(`Es demasiado largo (hasta ${b.max} letras).`);
    if (MONTO.test(texto)) {
      error(
        b.clave === 'politicaDevolucion'
          ? 'No escribas montos: usa {inscripcion} para la cuota de inscripción, que sale de Precios.'
          : 'No escribas montos acá: los valores salen de la sección Precios y de la cotización.',
      );
    }
    if (ENLACE.test(texto)) error('No pongas enlaces acá: el bot solo comparte enlaces que entrega una herramienta.');
    const desconocidos = (texto.match(/\{[^}]*\}/g) ?? []).filter((m) => !b.marcadores.includes(m));
    if (desconocidos.length) {
      error(
        b.marcadores.length
          ? `${desconocidos.join(', ')} no se completa solo. Acá solo sirve${b.marcadores.length > 1 ? 'n' : ''} ${b.marcadores.join(' y ')}.`
          : `${desconocidos.join(', ')} no se completa solo: escribe el texto tal como debe leerlo el bot.`,
      );
    }
    for (const m of b.obligatorios) if (!texto.includes(m)) error(`Falta ${m}: el bot lo reemplaza por el de la persona.`);
    valor[b.clave] = texto;
  }
  if (errores.length) return { ok: false, errores };
  return { ok: true, valor };
}

/** Cómo queda cada bloque dentro del prompt, con los montos de Precios ya puestos. */
export function bloquesRenderizados(c: AjustesComportamiento, costos: CostosAdicionales) {
  return {
    plantillaTitulo: c.plantillaTitulo,
    incluyePrograma: c.incluyePrograma,
    politicaDevolucion: devolucionTexto(c.politicaDevolucion, costos),
    objecionesFrecuentes: c.objecionesFrecuentes,
    costos: costosAdicionalesTexto(costos),
  };
}

/** Lo que se agrega al final del prompt cuando el equipo cambió algún bloque: si un texto editado
 *  contradice una regla, manda la regla. Sin cambios no se agrega, y el prompt queda como siempre. */
export const PREVALECEN_LAS_REGLAS =
  'TEXTOS EDITADOS POR EL EQUIPO: la plantilla de validez del título, qué incluye el programa, la política de devolución y las objeciones frecuentes los mantiene el equipo de Carver. Si algo de esos textos contradice tu identidad, las reglas de precios y montos, los enlaces de pago, la acreditación o la derivación interna de este prompt, mandan esas reglas.';

/** El prompt con lo publicado en Comportamiento y los costos de Precios. Reemplaza cada texto de
 *  siempre por el vigente; lo que no aparece en el prompt (otra marca) queda intacto. */
export function promptConAjustes(texto: string, comportamiento: AjustesComportamiento, costos: CostosAdicionales): string {
  const antes = bloquesRenderizados(comportamientoPorDefecto(), COSTOS_ADICIONALES_DEFECTO);
  const ahora = bloquesRenderizados(comportamiento, costos);
  let out = texto;
  let bloqueEditado = false;
  for (const k of Object.keys(antes) as Array<keyof typeof antes>) {
    if (antes[k] === ahora[k] || !out.includes(antes[k])) continue;
    out = out.replace(antes[k], () => ahora[k]); // función: un "$" en el texto no se interpreta como patrón
    if (k !== 'costos' && !(k === 'politicaDevolucion' && comportamiento.politicaDevolucion === DEVOLUCION_DEFECTO)) bloqueEditado = true;
  }
  return bloqueEditado ? `${out}\n\n${PREVALECEN_LAS_REGLAS}` : out;
}
