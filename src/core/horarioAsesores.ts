import { config } from '../config';

/**
 * Cuándo hay asesores atendiendo, y por lo tanto cuándo el bot NO debe meterse.
 *
 * La regla es al revés de lo que suele esperarse de un bot: atiende de noche y los fines de semana,
 * y se aparta en horario de oficina, porque ahí están las personas. De lunes a viernes de 9:00 a
 * 18:30 hora de Chile el bot calla; el resto del tiempo —noches, madrugadas, sábados y domingos—
 * responde él.
 *
 * La hora sale de Intl con la zona horaria real y no de un offset fijo: Chile cambia la hora dos
 * veces al año, y con -3 cableado el bot se apagaría y encendería una hora corrido medio año.
 *
 * Lo que este módulo NO sabe: los feriados. Un 18 de septiembre a las 11:00 cuenta como horario
 * laboral y el bot se queda callado aunque no haya nadie. Para resolverlo haría falta un calendario
 * de feriados, que no existe en el proyecto.
 */

const TIMEZONE = 'America/Santiago';

const FORMATO = new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const DIAS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Día de la semana (0=domingo) y minutos transcurridos del día, en hora de Chile. */
export function momentoEnChile(fecha: Date): { dia: number; minutos: number } {
  const partes = FORMATO.formatToParts(fecha);
  const buscar = (t: string) => partes.find((p) => p.type === t)?.value ?? '';
  const dia = DIAS[buscar('weekday')] ?? 1;
  // "24" a medianoche en algunos entornos con hour12:false — se normaliza a 0.
  const hora = Number(buscar('hour')) % 24;
  return { dia, minutos: hora * 60 + Number(buscar('minute')) };
}

/** "18:30" → 1110. Un valor que no se entienda devuelve el de reserva, para no apagar el bot por un
 *  typo en una variable de entorno. */
export function minutosDeHora(texto: string, porDefecto: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(texto ?? '').trim());
  if (!m) return porDefecto;
  const min = Number(m[1]) * 60 + Number(m[2]);
  return min >= 0 && min <= 24 * 60 ? min : porDefecto;
}

/** ¿Hay asesores atendiendo en este momento? Con la regla desactivada devuelve false siempre: el bot
 *  atiende a toda hora, que es como funcionaba antes. */
export function asesoresDisponibles(fecha: Date = new Date()): boolean {
  if (!config.horarioAsesoresActivo) return false;
  const { dia, minutos } = momentoEnChile(fecha);
  if (!config.horarioAsesoresDias.includes(dia)) return false;
  const inicio = minutosDeHora(config.horarioAsesoresInicio, 9 * 60);
  const fin = minutosDeHora(config.horarioAsesoresFin, 18 * 60 + 30);
  return minutos >= inicio && minutos < fin;
}

/**
 * El próximo instante en que el bot puede hablar: `fecha` si ya está fuera de horario, o el momento
 * en que termina la jornada si cae dentro.
 *
 * Se calcula sumando los minutos que faltan para el cierre en vez de construir "hoy a las 18:30",
 * que obliga a armar una fecha en otra zona horaria y se rompe los dos domingos del año en que
 * Chile cambia la hora. Igual se verifica el resultado: si por un cambio de hora siguiera cayendo
 * dentro de la jornada, se avanza de a un minuto hasta salir.
 */
export function proximoFueraDeHorario(fecha: Date = new Date()): Date {
  if (!asesoresDisponibles(fecha)) return fecha;
  const fin = minutosDeHora(config.horarioAsesoresFin, 18 * 60 + 30);
  const { minutos } = momentoEnChile(fecha);
  let t = new Date(fecha.getTime() + Math.max(1, fin - minutos) * 60_000);
  for (let i = 0; i < 24 * 60 && asesoresDisponibles(t); i++) t = new Date(t.getTime() + 60_000);
  return t;
}

/** Para los logs y el panel: por qué el bot se está quedando callado. */
export function motivoHorario(fecha: Date = new Date()): string {
  const { dia, minutos } = momentoEnChile(fecha);
  const hh = String(Math.floor(minutos / 60)).padStart(2, '0');
  const mm = String(minutos % 60).padStart(2, '0');
  return `horario de asesores (${['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'][dia]} ${hh}:${mm} en Chile)`;
}
