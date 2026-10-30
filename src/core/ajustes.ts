import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../config';
import { log } from '../log';
import type { DetallePrograma } from '../ai/detalles';
import type { ProgramaCarver } from './condicionesCarver';
import {
  programasBase,
  programasPorDefecto,
  validarProgramas,
  preciosPorDefecto,
  validarPrecios,
  aplicarAjustesACondicion,
  aplicarAjustesADetalle,
  type AjustesProgramas,
  type AjustesPrecios,
} from './ajustesProgramas';
import { conocimientoPorDefecto, validarConocimiento, ESQUEMA_CONOCIMIENTO, type AjustesConocimiento } from './ajustesConocimiento';
import {
  comportamientoPorDefecto,
  validarComportamiento,
  comportamientoDisponible,
  promptConAjustes,
  type AjustesComportamiento,
} from './ajustesComportamiento';
import { accionesPorDefecto, validarAcciones, accionesDisponibles, type AjustesAcciones } from './ajustesAcciones';

/**
 * Ajustes del bot que se editan desde el panel de configuración (routes/panelConfig.ts), sin tocar
 * código ni Railway. Cada sección se guarda versionada en Postgres (tabla config_version): borrador,
 * publicada e historial.
 *
 * Mientras una sección no se haya publicado nunca, el bot usa exactamente lo de siempre —las variables
 * de entorno de config.ts y los archivos de datos de cada marca—, así que instalar el panel no cambia
 * nada hasta que alguien publique.
 *
 * El bot lee lo publicado desde una caché en memoria que se refresca cada 30 s (y al instante cuando se
 * publica desde esta misma instancia). Si Postgres cae, se queda con lo último que leyó: un corte de la
 * base no debe devolver el bot a valores viejos a mitad del día.
 */

export type Feriado = { fecha: string; nombre: string };

/** Sección "Horarios". Plana a propósito: una versión publicada antes de que existiera un campo nuevo
 *  se completa con el valor por defecto de ese campo (ver conDefectos). */
export type Horarios = {
  /** Si es false, el bot atiende a toda hora (no se aparta por horario de asesores). */
  asesoresActivo: boolean;
  /** Días con asesores: 0=domingo … 6=sábado. */
  asesoresDias: number[];
  asesoresInicio: string;
  asesoresFin: string;
  /** Días en que NO hay asesores aunque caigan en un día hábil: el bot atiende todo el día. */
  feriados: Feriado[];
  ritmoMinS: number;
  ritmoMaxS: number;
  /** Franja (hora de Chile, 0–24) en que pueden salir mensajes automáticos: recordatorios,
   *  primer contacto y reactivación. */
  automaticosHoraInicio: number;
  automaticosHoraFin: number;
};

export function horariosPorDefecto(): Horarios {
  // Se lee config en cada llamada (no se copia al importar): las pruebas, y cualquier ajuste en
  // caliente de config, siguen funcionando igual que antes de que existiera el panel.
  return {
    asesoresActivo: config.horarioAsesoresActivo,
    asesoresDias: [...config.horarioAsesoresDias],
    asesoresInicio: config.horarioAsesoresInicio,
    asesoresFin: config.horarioAsesoresFin,
    feriados: [],
    ritmoMinS: config.respuestaDelayMinS,
    ritmoMaxS: config.respuestaDelayMaxS,
    automaticosHoraInicio: config.seguimientoHoraInicio,
    automaticosHoraFin: config.seguimientoHoraFin,
  };
}

export type ErrorCampo = { campo: string; mensaje: string };
export type Validacion<T> = { ok: true; valor: T } | { ok: false; errores: ErrorCampo[] };

// Los mensajes los lee alguien que no programa: dicen qué corregir, no qué regla se violó.
const MAX_FERIADOS = 60;
const MAX_RITMO_S = 60;

function minutosHHMM(texto: unknown): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(String(texto ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min > 0)) return null;
  return h * 60 + min;
}

function fechaValida(texto: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) return false;
  const d = new Date(`${texto}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === texto;
}

const esEntero = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);

export function validarHorarios(entrada: unknown): Validacion<Horarios> {
  const x = (entrada ?? {}) as Record<string, unknown>;
  const errores: ErrorCampo[] = [];
  const error = (campo: string, mensaje: string) => errores.push({ campo, mensaje });

  if (typeof x.asesoresActivo !== 'boolean') error('asesoresActivo', 'Indica si el bot debe apartarse en el horario de asesores.');
  const activo = x.asesoresActivo === true;

  const diasCrudos = Array.isArray(x.asesoresDias) ? x.asesoresDias : null;
  let dias: number[] = [];
  if (!diasCrudos || !diasCrudos.every((d) => esEntero(d) && d >= 0 && d <= 6)) {
    error('asesoresDias', 'Los días de asesores no son válidos.');
  } else {
    dias = [...new Set(diasCrudos as number[])].sort((a, b) => a - b);
    if (activo && !dias.length) error('asesoresDias', 'Elige al menos un día con asesores, o desactiva el horario de asesores.');
  }

  const inicio = minutosHHMM(x.asesoresInicio);
  const fin = minutosHHMM(x.asesoresFin);
  if (inicio === null) error('asesoresInicio', 'La hora de inicio debe tener el formato 09:00.');
  if (fin === null) error('asesoresFin', 'La hora de término debe tener el formato 18:30.');
  if (inicio !== null && fin !== null && fin <= inicio) error('asesoresFin', 'La hora de término debe ser posterior a la de inicio.');

  const feriados: Feriado[] = [];
  if (!Array.isArray(x.feriados)) {
    error('feriados', 'La lista de feriados no es válida.');
  } else if (x.feriados.length > MAX_FERIADOS) {
    error('feriados', `Puedes cargar hasta ${MAX_FERIADOS} feriados.`);
  } else {
    const vistas = new Set<string>();
    for (const f of x.feriados as unknown[]) {
      const fecha = String((f as any)?.fecha ?? '').trim();
      const nombre = String((f as any)?.nombre ?? '').trim().slice(0, 80);
      if (!fechaValida(fecha)) {
        error('feriados', `"${fecha || '(vacía)'}" no es una fecha válida.`);
        continue;
      }
      if (vistas.has(fecha)) {
        error('feriados', `La fecha ${fecha} está repetida.`);
        continue;
      }
      vistas.add(fecha);
      feriados.push({ fecha, nombre });
    }
    feriados.sort((a, b) => a.fecha.localeCompare(b.fecha));
  }

  const ritmoMin = x.ritmoMinS;
  const ritmoMax = x.ritmoMaxS;
  const ritmoValido = (n: unknown) => esEntero(n) && n >= 0 && n <= MAX_RITMO_S;
  if (!ritmoValido(ritmoMin)) error('ritmoMinS', `La espera mínima debe ser un número entero entre 0 y ${MAX_RITMO_S} segundos.`);
  if (!ritmoValido(ritmoMax)) error('ritmoMaxS', `La espera máxima debe ser un número entero entre 0 y ${MAX_RITMO_S} segundos.`);
  if (ritmoValido(ritmoMin) && ritmoValido(ritmoMax) && (ritmoMin as number) > (ritmoMax as number)) {
    error('ritmoMinS', 'La espera mínima no puede ser mayor que la máxima.');
  }

  const autoIni = x.automaticosHoraInicio;
  const autoFin = x.automaticosHoraFin;
  const horaValida = (n: unknown) => esEntero(n) && n >= 0 && n <= 24;
  if (!horaValida(autoIni)) error('automaticosHoraInicio', 'La hora desde la que salen mensajes automáticos debe estar entre 0 y 24.');
  if (!horaValida(autoFin)) error('automaticosHoraFin', 'La hora hasta la que salen mensajes automáticos debe estar entre 0 y 24.');
  if (horaValida(autoIni) && horaValida(autoFin) && (autoFin as number) <= (autoIni as number)) {
    error('automaticosHoraFin', 'La hora de término de los mensajes automáticos debe ser posterior a la de inicio.');
  }

  if (errores.length) return { ok: false, errores };
  return {
    ok: true,
    valor: {
      asesoresActivo: activo,
      asesoresDias: dias,
      asesoresInicio: String(x.asesoresInicio).trim(),
      asesoresFin: String(x.asesoresFin).trim(),
      feriados,
      ritmoMinS: ritmoMin as number,
      ritmoMaxS: ritmoMax as number,
      automaticosHoraInicio: autoIni as number,
      automaticosHoraFin: autoFin as number,
    },
  };
}

type DefSeccion<T> = {
  titulo: string;
  porDefecto: () => T;
  validar: (x: unknown) => Validacion<T>;
  /** Cómo dibujar el formulario, cuando depende de los datos (los temas del conocimiento institucional). */
  esquema?: () => unknown;
};

/** Secciones que el panel puede editar. Se agregan acá a medida que se construyen las fases. */
export const SECCIONES = {
  horarios: { titulo: 'Horarios', porDefecto: horariosPorDefecto, validar: validarHorarios } as DefSeccion<Horarios>,
  programas: { titulo: 'Programas y modalidad', porDefecto: programasPorDefecto, validar: validarProgramas } as DefSeccion<AjustesProgramas>,
  precios: { titulo: 'Precios', porDefecto: preciosPorDefecto, validar: validarPrecios } as DefSeccion<AjustesPrecios>,
  conocimiento: {
    titulo: 'Conocimiento institucional',
    porDefecto: conocimientoPorDefecto,
    validar: validarConocimiento,
    esquema: () => ESQUEMA_CONOCIMIENTO,
  } as DefSeccion<AjustesConocimiento>,
  comportamiento: { titulo: 'Comportamiento', porDefecto: comportamientoPorDefecto, validar: validarComportamiento } as DefSeccion<AjustesComportamiento>,
  acciones: { titulo: 'Acciones', porDefecto: accionesPorDefecto, validar: validarAcciones } as DefSeccion<AjustesAcciones>,
};

export type NombreSeccion = keyof typeof SECCIONES;

export function esSeccion(x: unknown): x is NombreSeccion {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(SECCIONES, x);
}

/** Lo publicado, completado con los valores por defecto de los campos que no traiga. */
function conDefectos(seccion: NombreSeccion, contenido: unknown): Validacion<unknown> {
  const def = SECCIONES[seccion];
  const base = def.porDefecto() as Record<string, unknown>;
  const extra = contenido && typeof contenido === 'object' && !Array.isArray(contenido) ? (contenido as Record<string, unknown>) : {};
  return def.validar({ ...base, ...extra });
}

const publicadas = new Map<NombreSeccion, unknown>();

// Valores de PRUEBA que rigen solo dentro de una ejecución puntual: el chat simulado del panel prueba
// los borradores sin publicarlos (ai/simulador.ts). Viven en el contexto asíncrono de esa ejecución,
// así que las conversaciones reales que corren al mismo tiempo siguen viendo lo publicado.
const deprueba = new AsyncLocalStorage<Map<NombreSeccion, unknown>>();

/** Ejecuta `fn` con estos valores en lugar de lo publicado, solo para esa ejecución. Ya validados. */
export function conAjustesDePrueba<T>(valores: Partial<Record<NombreSeccion, unknown>>, fn: () => Promise<T>): Promise<T> {
  return deprueba.run(new Map(Object.entries(valores) as Array<[NombreSeccion, unknown]>), fn);
}

/** Lo que el bot usa AHORA en "Horarios": lo publicado o, si no hay nada, lo de Railway. */
export function horarios(): Horarios {
  return vigente('horarios') as Horarios;
}

/** Valor vigente de cualquier sección: el de prueba si se está simulando, si no lo publicado, y si no
 *  hay nada publicado, el valor por defecto. */
export function vigente(seccion: NombreSeccion): unknown {
  const prueba = deprueba.getStore();
  if (prueba?.has(seccion)) return prueba.get(seccion);
  return publicadas.get(seccion) ?? SECCIONES[seccion].porDefecto();
}

/** Secciones que tienen algo que editar en esta marca: Programas, Precios y Conocimiento existen solo
 *  donde hay oferta comercial y base de conocimiento cargadas (hoy, Carver). */
export function seccionesDisponibles(): NombreSeccion[] {
  const out: NombreSeccion[] = ['horarios'];
  if (programasBase().length) out.push('programas', 'precios');
  if (Object.keys(conocimientoPorDefecto().temas).length) out.push('conocimiento');
  if (comportamientoDisponible()) out.push('comportamiento');
  if (accionesDisponibles()) out.push('acciones');
  return out;
}

export function ajustesAcciones(): AjustesAcciones {
  return vigente('acciones') as AjustesAcciones;
}

export function ajustesConocimiento(): AjustesConocimiento {
  return vigente('conocimiento') as AjustesConocimiento;
}

export function ajustesComportamiento(): AjustesComportamiento {
  return vigente('comportamiento') as AjustesComportamiento;
}

/** El prompt de sistema con lo publicado en Comportamiento y los costos de Precios. Sin nada
 *  publicado devuelve el mismo texto. */
export function promptVigente(texto: string): string {
  return promptConAjustes(texto, ajustesComportamiento(), ajustesPrecios().costosAdicionales);
}

export function ajustesProgramas(): AjustesProgramas {
  return vigente('programas') as AjustesProgramas;
}

export function ajustesPrecios(): AjustesPrecios {
  return vigente('precios') as AjustesPrecios;
}

/** Condiciones comerciales de un programa con lo publicado en el panel (disponibilidad y precios). */
export function condicionVigente(c: ProgramaCarver): ProgramaCarver & { reabre?: string } {
  return aplicarAjustesACondicion(c, ajustesProgramas(), ajustesPrecios());
}

/** Detalle de un programa con lo publicado en el panel (modalidad, duración, brochure). */
export function detalleVigente<T extends DetallePrograma | undefined>(d: T): T {
  return (d ? aplicarAjustesADetalle(d, ajustesProgramas()) : d) as T;
}

/** Cómo se lee lo publicado (store/db.ts:dbConfigPublicadas). null = no se pudo leer. Se recibe como
 *  parámetro para que este módulo —que usan horarios, ritmo y seguimientos— no dependa de la base. */
export type LectorPublicadas = () => Promise<Array<{ seccion: string; contenido: unknown }> | null>;

/** Relee lo publicado. Si no se pudo leer, no toca la caché. */
export async function refrescarAjustes(leer: LectorPublicadas): Promise<void> {
  const filas = await leer();
  if (filas === null) return;
  const nuevas = new Map<NombreSeccion, unknown>();
  for (const f of filas) {
    if (!esSeccion(f.seccion)) continue;
    const v = conDefectos(f.seccion, f.contenido);
    // No debería pasar —se valida al publicar—, pero si una versión vieja dejó de ser válida tras un
    // cambio de reglas, se ignora y rige el valor por defecto, en vez de romper el bot.
    if (v.ok) nuevas.set(f.seccion, v.valor);
    else log.warn('ajustes: la versión publicada no es válida; se usa el valor por defecto', { seccion: f.seccion, errores: v.errores });
  }
  publicadas.clear();
  for (const [k, v] of nuevas) publicadas.set(k, v);
}

let refrescoTimer: ReturnType<typeof setInterval> | null = null;

export function iniciarRefrescoAjustes(leer: LectorPublicadas): void {
  const refrescar = () =>
    void refrescarAjustes(leer).catch((e) => log.warn('ajustes: no se pudo leer la configuración publicada', { err: String(e) }));
  refrescar();
  if (refrescoTimer) return;
  refrescoTimer = setInterval(refrescar, 30_000);
  refrescoTimer.unref?.();
}

/** Solo para pruebas: fija (o borra, con null) el valor publicado de una sección. */
export function _fijarPublicadaParaPruebas(seccion: NombreSeccion, valor: unknown | null): void {
  if (valor === null) publicadas.delete(seccion);
  else publicadas.set(seccion, valor);
}
