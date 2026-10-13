import { config } from '../config';

/**
 * ¿Esta persona puede trabajar un caso de ESTA marca?
 *
 * Hallazgo 9 de la auditoría del piloto de Carver: el bot respetaba al responsable de la negociación
 * siempre que fuera "un asesor vigente", sin mirar de qué equipo era. Como Postgrados, IPG y Carver
 * comparten portal, una ficha que Bitrix enlazaba al chat podía estar a cargo de alguien de otro
 * equipo; el bot le dejaba la tarea de seguimiento y, peor, se presentaba al cliente con su nombre.
 *
 * Reglas, en orden:
 *  - sin equipo configurado (Postgrados) → cualquiera vale, como antes;
 *  - el punto de entrada único (BITRIX_DERIVAR_A) siempre es del equipo;
 *  - los usuarios listados en BITRIX_EQUIPO_USUARIOS son del equipo;
 *  - quien pertenece a uno de los departamentos de BITRIX_EQUIPO_DEPARTAMENTOS es del equipo.
 */
export function perteneceAlEquipo(u: { id: number; departamentos?: number[] }): boolean {
  if (!config.equipoDepartamentos.length && !config.equipoUsuarios.length) return true;
  if (!u?.id) return false;
  if (config.derivarATodo && u.id === config.derivarATodo) return true;
  if (config.equipoUsuarios.includes(u.id)) return true;
  return (u.departamentos ?? []).some((d) => config.equipoDepartamentos.includes(d));
}

/** Un responsable que de verdad puede atender: persona (no robot), no el responsable por defecto del
 *  embudo, activa, y del equipo de la marca. */
export function esAsesorValido(u: { id: number; activo?: boolean; departamentos?: number[] } | null | undefined): boolean {
  if (!u?.id) return false;
  if (config.usuariosAutomaticos.includes(u.id)) return false;
  if (config.responsablesPorDefecto.includes(u.id)) return false;
  if (u.activo === false) return false;
  return perteneceAlEquipo(u);
}
