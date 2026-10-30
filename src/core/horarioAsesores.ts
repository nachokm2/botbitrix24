import { horarios, type Horarios } from './ajustes';

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
 * Los feriados se cargan en el panel de configuración (sección Horarios): sin ellos, un 18 de
 * septiembre a las 11:00 contaba como horario laboral y el bot se quedaba callado aunque no hubiera
 * nadie. Horario y feriados salen de ajustes.ts: lo publicado en el panel o, si no hay nada, las
 * variables de entorno de siempre.
 */

const TIMEZONE = 'America/Santiago';

const FORMATO = new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

// en-CA da la fecha como AAAA-MM-DD, el mismo formato en que se guardan los feriados.
const FORMATO_FECHA = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

const DIAS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Día de la semana (0=domingo), minutos transcurridos del día y fecha (AAAA-MM-DD), en hora de Chile. */
export function momentoEnChile(fecha: Date): { dia: number; minutos: number; fecha: string } {
  const partes = FORMATO.formatToParts(fecha);
  const buscar = (t: string) => partes.find((p) => p.type === t)?.value ?? '';
  const dia = DIAS[buscar('weekday')] ?? 1;
  // "24" a medianoche en algunos entornos con hour12:false — se normaliza a 0.
  const hora = Number(buscar('hour')) % 24;
  return { dia, minutos: hora * 60 + Number(buscar('minute')), fecha: FORMATO_FECHA.format(fecha) };
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
 *  atiende a toda hora, que es como funcionaba antes. En un feriado tampoco hay asesores. */
export function asesoresDisponibles(fecha: Date = new Date(), h: Horarios = horarios()): boolean {
  if (!h.asesoresActivo) return false;
  const { dia, minutos, fecha: hoy } = momentoEnChile(fecha);
  if (h.feriados.some((f) => f.fecha === hoy)) return false;
  if (!h.asesoresDias.includes(dia)) return false;
  const inicio = minutosDeHora(h.asesoresInicio, 9 * 60);
  const fin = minutosDeHora(h.asesoresFin, 18 * 60 + 30);
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
export function proximoFueraDeHorario(fecha: Date = new Date(), h: Horarios = horarios()): Date {
  if (!asesoresDisponibles(fecha, h)) return fecha;
  const fin = minutosDeHora(h.asesoresFin, 18 * 60 + 30);
  const { minutos } = momentoEnChile(fecha);
  let t = new Date(fecha.getTime() + Math.max(1, fin - minutos) * 60_000);
  for (let i = 0; i < 24 * 60 && asesoresDisponibles(t, h); i++) t = new Date(t.getTime() + 60_000);
  return t;
}

export type DiaVista = {
  fecha: string;
  dia: number;
  /** Nombre del feriado, si el día lo es. */
  feriado: string | null;
  /** Franja en que hay asesores (y el bot calla), o null si ese día el bot atiende todo el día. */
  asesores: { inicio: string; fin: string } | null;
};

/**
 * Los próximos `dias` días tal como los viviría el bot con el horario `h`. Es la "prueba" del panel
 * antes de publicar: quien edita ve en palabras qué pasa cada día, en vez de imaginárselo.
 */
export function vistaSemanal(h: Horarios, desde: Date = new Date(), dias = 7): DiaVista[] {
  // Se ancla al mediodía en Chile: sumando días desde ahí, un cambio de hora (±1 h) nunca hace saltar
  // ni repetir una fecha, como sí pasaría partiendo de las 23:30.
  const { minutos } = momentoEnChile(desde);
  const mediodia = desde.getTime() - minutos * 60_000 + 12 * 3600_000;
  const out: DiaVista[] = [];
  for (let i = 0; i < dias; i++) {
    const { dia, fecha } = momentoEnChile(new Date(mediodia + i * 86_400_000));
    const feriado = h.feriados.find((f) => f.fecha === fecha);
    const hayAsesores = h.asesoresActivo && !feriado && h.asesoresDias.includes(dia);
    out.push({
      fecha,
      dia,
      feriado: feriado ? feriado.nombre || 'Feriado' : null,
      asesores: hayAsesores ? { inicio: h.asesoresInicio, fin: h.asesoresFin } : null,
    });
  }
  return out;
}

/** Para los logs y el panel: por qué el bot se está quedando callado. */
export function motivoHorario(fecha: Date = new Date()): string {
  const { dia, minutos } = momentoEnChile(fecha);
  const hh = String(Math.floor(minutos / 60)).padStart(2, '0');
  const mm = String(minutos % 60).padStart(2, '0');
  return `horario de asesores (${['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'][dia]} ${hh}:${mm} en Chile)`;
}
