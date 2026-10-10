import { retrieve } from './retrieval';
import { esProgramaCotizable } from './condicionesComerciales';
import { getDetalle } from '../ai/detalles';
import { marca } from '../marca';

// Núcleo compartido de las herramientas de catálogo (M1 + M5). La BÚSQUEDA (retrieve, ver retrieval.ts)
// y el DETALLE (getDetalle) son funciones compartidas; lo que estaba DUPLICADO —y divergía— era el "shaping"
// del resultado por canal (chat devolvía top-20 con objetos completos; voz top-8 reducido, con notas
// distintas). Aquí ese shaping vive en UN solo lugar, parametrizado por el perfil de canal, de modo
// que agregar un canal nuevo no vuelve a duplicar la lógica: solo declara su presentación en el perfil.

/** Cómo presenta un canal el resultado de `consultar_programas`. Vive en el ChannelProfile. */
export type ConsultarPresentation = {
  /** Máximo de programas a devolver (chat 20, voz 8). */
  limit: number;
  /** true: objetos completos (chat); false: reducidos a nombre/tipo/facultad/modalidad (voz). */
  verbose: boolean;
  /** true: envuelve con {ok, total, mostrando} (chat); false: solo {total, programas, nota} (voz). */
  wrapOk: boolean;
  /** Nota cuando hay más resultados que `limit`. */
  moreNote: string;
  /** Nota cuando NO hay coincidencias (voz la usa para evitar que el modelo invente; chat la omite). */
  emptyNote?: string;
};

/** Forma del detalle según canal: 'full' (objeto completo, chat) o 'voice' (campos clave para hablar). */
export type DetalleShape = 'full' | 'voice';

/** consultar_programas unificado: busca en el catálogo y da forma al resultado según el canal. */
export function consultarProgramas(input: any, p: ConsultarPresentation) {
  // Solo recomienda lo que se puede COTIZAR/vender: excluye masivos/becas, pausa, suspendidos, matrícula
  // cerrada, nuevos sin precio, bloqueados y lo que no está en la planilla comercial.
  // El filtro comercial solo aplica donde existe esa planilla (Postgrados). En otra marca dejaría
  // el catálogo en CERO: ninguno de sus programas figura en la planilla de Postgrados.
  const encontrados = retrieve(input ?? {});
  // Carver SÍ ofrece lo que tiene los cupos completos: son programas vigentes que reabren matrícula
  // en marzo de 2027, y esconderlos hacía perder interesados en los dos de mayor valor del catálogo
  // (las licenciaturas de USD 8.000). En vez de filtrarlos, se marcan: el bot los presenta y avisa
  // desde cuándo se puede postular. En Postgrados el filtro se mantiene — ahí excluye otra cosa:
  // becas no habilitadas, programas en pausa y suspendidos, que no corresponde ofrecer.
  const marcarDisponibilidad = marca.key === 'carver';
  const all = marca.usaPlanillaComercial && !marcarDisponibilidad
    ? encontrados.filter((x) => esProgramaCotizable(x.nombre))
    : encontrados;
  const shown = all.slice(0, p.limit);
  const conEstado = (x: any) =>
    marcarDisponibilidad && !esProgramaCotizable(x.nombre)
      ? {
          ...x,
          disponible: false,
          disponibilidad:
            'NO disponible ahora: cupos completos. La matrícula reabre en MARZO DE 2027. No lo ofrezcas como opción actual ni lo recomiendes primero; menciónalo solo como alternativa para 2027 si la persona pregunta por él o si encaja con lo que busca, y registra su interés para avisarle cuando abra.',
        }
      : x;
  const programas = p.verbose
    ? shown.map(conEstado)
    : shown.map((x) => conEstado({ nombre: x.nombre, tipo: x.tipo, facultad: x.facultad, modalidad: x.modalidad }));
  // Cuántos resultados se pueden ENUMERAR en un chat sin abrumar. La nota de "afina la búsqueda"
  // solo se disparaba al superar el límite (20), así que con 13 maestrías no aparecía nunca y el bot
  // las listaba todas, con enlace y emoji por cada una: un muro de texto en WhatsApp. El tope es del
  // canal, no del catálogo — por eso va acá y no en el prompt, que el modelo puede ignorar.
  const COMODO_PARA_LISTAR = 6;
  const nota =
    all.length === 0
      ? p.emptyNote
      : all.length > p.limit
        ? p.moreNote
        : all.length > COMODO_PARA_LISTAR
          ? `Son ${all.length} programas: NO los enumeres todos ni pegues sus enlaces. Dile cuántos hay, menciona las ÁREAS o temas que cubren en una frase, y pregúntale cuál le interesa para profundizar en ese. Ofrece primero los que estén disponibles: los que traigan "disponible: false" solo se mencionan como alternativa para 2027.`
          : undefined;

  if (p.wrapOk) {
    return { ok: true, total: all.length, mostrando: Math.min(all.length, p.limit), programas, nota };
  }
  return { total: all.length, programas, nota };
}

// El PRECIO ya NO sale de detalle_programa: traía el arancel de LISTA (sin descuento), lo que hacía que el
// bot cotizara de más. El precio real (arancel con descuento institucional, matrícula, total y cuotas Toku)
// vive en consultar_condiciones_comerciales. Aquí quedan requisitos/malla/descripción/objetivos.
const NOTA_PRECIO =
  'Para arancel, matrícula, descuento, total o cuotas usa consultar_condiciones_comerciales (trae el precio ' +
  'con descuento real). No cotices con estos datos: el arancel de lista quedó fuera a propósito.';

/** detalle_programa unificado: busca el detalle y lo presenta completo (chat) o reducido para voz. Sin precio. */
export function detallePrograma(input: any, shape: DetalleShape) {
  const d = getDetalle({ url: input?.url, nombre: input?.nombre });

  if (shape === 'full') {
    if (!d) {
      return {
        ok: false,
        error: 'SIN_DETALLE',
        mensaje:
          'Aún no tengo el detalle cargado de ese programa. Comparte la URL oficial y ofrece derivar a un asesor.',
      };
    }
    const detalleSinPrecio: Record<string, unknown> = { ...d };
    delete detalleSinPrecio.arancel; // el precio va por consultar_condiciones_comerciales
    delete detalleSinPrecio.matricula;
    return { ok: true, detalle: detalleSinPrecio, nota_precio: NOTA_PRECIO };
  }

  // Voz: solo los campos que la asistente necesita para hablar (sin malla/objetivos/brochure ni precio).
  if (!d) return { encontrado: false, mensaje: 'Sin detalle cargado; ofrece derivar a un asesor.' };
  return {
    encontrado: true,
    nombre: d.nombre,
    requisitos: d.requisitos,
    descripcion: d.descripcion,
    fechaInicio: d.fechaInicio,
    nota_precio: NOTA_PRECIO,
  };
}
