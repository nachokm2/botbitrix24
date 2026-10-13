import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Base de conocimiento comercial VERIFICABLE (calendario de ingresos, argumentos de venta, enlace de
 * postulación del asesor y proceso de admisión).
 *
 * El problema que resuelve no es técnico sino de procedencia: estos datos los pide el cliente todos
 * los días y hoy no existen en ninguna fuente que el bot pueda citar. En el piloto, un asesor le dio
 * a un cliente una fecha de inicio que no estaba escrita en ningún lado; si el bot hiciera lo mismo,
 * la fecha se repetiría a cientos de personas.
 *
 * Cada tema lleva estado, fuente, responsable y vigencia. El bot solo recibe lo que está VALIDADO,
 * VIGENTE, COMPLETO y SIN CONTRADICCIONES; en cualquier otro caso recibe "no disponible" y la
 * instrucción de no inventarlo. Así el módulo puede estar implementado (aceptación técnica) mientras
 * el contenido sigue pendiente (aceptación comercial), y cargarlo no obliga a tocar la conversación.
 */

export const TEMAS = ['calendario_ingresos', 'argumentos_venta', 'enlace_postulacion', 'proceso_admision'] as const;
export type Tema = (typeof TEMAS)[number];

type EntradaTema = Record<string, unknown>;
export type DefinicionTema = {
  titulo: string;
  estado: string;
  fuente: string | null;
  responsable: string | null;
  vigenteHasta: string | null;
  actualizado: string | null;
  camposObligatorios: string[];
  entradas: EntradaTema[];
};
export type BaseConocimiento = { temas: Record<string, DefinicionTema> };

const RUTA = fileURLToPath(new URL('../../data/carver/conocimiento-comercial.json', import.meta.url));

function cargar(): BaseConocimiento {
  try {
    return JSON.parse(readFileSync(RUTA, 'utf8')) as BaseConocimiento;
  } catch {
    return { temas: {} };
  }
}

export const BASE_CONOCIMIENTO: BaseConocimiento = cargar();

export const INSTRUCCION_SIN_DATO =
  'No tienes este dato verificado. NO lo inventes ni lo estimes: ni fechas, ni enlaces, ni pasos, ni ' +
  'plazos. Dilo con naturalidad en una frase y ofrece confirmarlo y responderle por este medio. Si la persona lo ' +
  'necesita para decidir, deja la consulta registrada con registrar_interes_crm (en "comentario").';

export type ResultadoConocimiento =
  | { ok: false; error: 'TEMA_DESCONOCIDO'; temas: readonly string[] }
  | { ok: true; tema: Tema; disponible: false; motivo: string; instruccion: string }
  | { ok: true; tema: Tema; disponible: true; contenido: EntradaTema[]; fuente: string | null; vigenteHasta: string | null };

const hoyISO = (d: Date) => d.toISOString().slice(0, 10);

function completa(e: EntradaTema, campos: string[]): boolean {
  return campos.every((c) => e[c] !== undefined && e[c] !== null && String(e[c]).trim() !== '');
}

export function consultarInformacionInstitucional(
  temaPedido: string,
  opts: { hoy?: Date; asesorId?: number | null } = {},
  base: BaseConocimiento = BASE_CONOCIMIENTO,
): ResultadoConocimiento {
  const tema = TEMAS.find((t) => t === temaPedido);
  if (!tema) return { ok: false, error: 'TEMA_DESCONOCIDO', temas: TEMAS };
  const noDisponible = (motivo: string) =>
    ({ ok: true, tema, disponible: false, motivo, instruccion: INSTRUCCION_SIN_DATO }) as const;

  const def = base.temas?.[tema];
  if (!def) return noDisponible('sin_definicion');
  if (def.estado !== 'validado') return noDisponible('pendiente_de_validacion');
  if (!def.fuente) return noDisponible('sin_fuente');
  const hoy = hoyISO(opts.hoy ?? new Date());
  if (def.vigenteHasta && def.vigenteHasta < hoy) return noDisponible('vencido');

  let entradas = (def.entradas ?? []).filter((e) => completa(e, def.camposObligatorios));
  if (!entradas.length) return noDisponible('incompleto');

  if (tema === 'calendario_ingresos') {
    // Un ciclo cuyo inicio ya pasó no se ofrece como próximo ingreso.
    entradas = entradas.filter((e) => String(e.inicioClases) >= hoy);
    if (!entradas.length) return noDisponible('vencido');
    // Dos fechas distintas para el mismo ciclo y programa: no se elige una al azar.
    const vistos = new Map<string, string>();
    for (const e of entradas) {
      const clave = `${e.ciclo}|${e.programa}`;
      const previa = vistos.get(clave);
      if (previa && previa !== String(e.inicioClases)) return noDisponible('contradictorio');
      vistos.set(clave, String(e.inicioClases));
    }
  }

  if (tema === 'enlace_postulacion') {
    // El enlace es PERSONAL del asesor de ventas: sin asesor resuelto no hay enlace que entregar.
    if (!opts.asesorId) return noDisponible('sin_asesor_asignado');
    entradas = entradas.filter((e) => Number(e.asesorId) === opts.asesorId && /^https:\/\//.test(String(e.url)));
    if (!entradas.length) return noDisponible('sin_enlace_para_el_asesor');
    if (new Set(entradas.map((e) => String(e.url))).size > 1) return noDisponible('contradictorio');
    entradas = entradas.slice(0, 1);
  }

  return { ok: true, tema, disponible: true, contenido: entradas, fuente: def.fuente, vigenteHasta: def.vigenteHasta };
}

/** Estado de los cuatro temas, para el informe de aceptación comercial. */
export function estadoTemas(base: BaseConocimiento = BASE_CONOCIMIENTO) {
  return TEMAS.map((t) => {
    const d = base.temas?.[t];
    return {
      tema: t,
      estado: d?.estado ?? 'sin_definicion',
      entradas: d?.entradas?.length ?? 0,
      fuente: d?.fuente ?? null,
      responsable: d?.responsable ?? null,
      vigenteHasta: d?.vigenteHasta ?? null,
    };
  });
}
