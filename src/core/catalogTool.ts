import { retrieve } from './retrieval';
import { esProgramaCotizable } from './condicionesComerciales';
import { getDetalle } from '../ai/detalles';

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
  const all = retrieve(input ?? {}).filter((x) => esProgramaCotizable(x.nombre));
  const shown = all.slice(0, p.limit);
  const programas = p.verbose
    ? shown
    : shown.map((x) => ({ nombre: x.nombre, tipo: x.tipo, facultad: x.facultad, modalidad: x.modalidad }));
  const nota = all.length === 0 ? p.emptyNote : all.length > p.limit ? p.moreNote : undefined;

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
    nota_precio: NOTA_PRECIO,
  };
}
