import { horarios, type Horarios } from './ajustes';
import { momentoEnChile, minutosDeHora } from './horarioAsesores';

/**
 * Qué día es y cuándo trabaja el equipo, dicho para el bot.
 *
 * El bot prometía "lo confirmo y le respondo a la brevedad" un viernes a las 13:00 de Chile, con la
 * asesora ya fuera de horario: la respuesta llegaba el lunes y el cliente esperó todo el fin de
 * semana algo que le dijeron que era inmediato (chat 1383805, 31-10-2026). Con este bloque el bot sabe
 * si el equipo está trabajando y, si no, cuándo vuelve, para decirlo con la verdad.
 *
 * El horario del EQUIPO es el de la sección Horarios del panel, aunque la regla de que el bot calle en
 * ese horario esté apagada: que el bot atienda a toda hora no significa que las personas también.
 *
 * Sin minutos a propósito: el texto cambia solo al empezar o terminar la jornada y al cambiar de día.
 * Va en el system del turno, y si cambiara a cada minuto rompería la caché del prompt en cada mensaje.
 */

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** "2026-11-02" + lunes → "lunes 2 de noviembre". */
function fechaLarga(fecha: string, dia: number): string {
  const [, mes, d] = fecha.split('-').map(Number);
  return `${DIAS[dia]} ${d} de ${MESES[mes - 1]}`;
}

/** "09:00" → "9:00". */
const hora = (texto: string) => texto.replace(/^0(\d)/, '$1');

function diasTexto(dias: number[]): string {
  const orden = [...new Set(dias)].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)); // de lunes a domingo
  const clave = orden.join(',');
  if (clave === '1,2,3,4,5') return 'de lunes a viernes';
  if (clave === '1,2,3,4,5,6') return 'de lunes a sábado';
  const nombres = orden.map((d) => DIAS[d]);
  return nombres.length > 1 ? `${nombres.slice(0, -1).join(', ')} y ${nombres[nombres.length - 1]}` : (nombres[0] ?? '');
}

/** ¿El equipo está trabajando en este momento? Como asesoresDisponibles, pero SIN mirar si la regla
 *  del bot está activa (ver arriba). */
export function equipoTrabajando(fecha: Date = new Date(), h: Horarios = horarios()): boolean {
  const { dia, minutos, fecha: hoy } = momentoEnChile(fecha);
  if (h.feriados.some((f) => f.fecha === hoy)) return false;
  if (!h.asesoresDias.includes(dia)) return false;
  return minutos >= minutosDeHora(h.asesoresInicio, 9 * 60) && minutos < minutosDeHora(h.asesoresFin, 18 * 60 + 30);
}

/** Cuándo vuelve el equipo: "hoy desde las 9:00", "mañana martes 3 de noviembre desde las 9:00" o
 *  "el lunes 2 de noviembre desde las 9:00". null si está trabajando ahora o no hay días de trabajo. */
export function proximaJornada(fecha: Date = new Date(), h: Horarios = horarios()): string | null {
  if (!h.asesoresDias.length || equipoTrabajando(fecha, h)) return null;
  const inicio = minutosDeHora(h.asesoresInicio, 9 * 60);
  const desde = `desde las ${hora(h.asesoresInicio)}`;
  const ahora = momentoEnChile(fecha);
  // Se ancla al mediodía en Chile, como en vistaSemanal: sumar días desde ahí no salta ni repite
  // fechas con el cambio de hora.
  const mediodia = fecha.getTime() - ahora.minutos * 60_000 + 12 * 3600_000;
  for (let i = 0; i <= 14; i++) {
    const { dia, fecha: f } = momentoEnChile(new Date(mediodia + i * 86_400_000));
    if (!h.asesoresDias.includes(dia) || h.feriados.some((x) => x.fecha === f)) continue;
    if (i === 0) {
      if (ahora.minutos < inicio) return `hoy ${desde}`;
      continue; // la jornada de hoy ya terminó
    }
    return i === 1 ? `mañana ${fechaLarga(f, dia)} ${desde}` : `el ${fechaLarga(f, dia)} ${desde}`;
  }
  return null;
}

/** Bloque para el system del turno. */
export function bloqueMomento(fecha: Date = new Date(), h: Horarios = horarios()): string {
  const { dia, fecha: hoy } = momentoEnChile(fecha);
  const partes = [`MOMENTO ACTUAL (hora de Chile): hoy es ${fechaLarga(hoy, dia)}.`];
  if (h.asesoresDias.length) {
    partes.push(`El equipo de admisiones trabaja ${diasTexto(h.asesoresDias)} de ${hora(h.asesoresInicio)} a ${hora(h.asesoresFin)}.`);
    const vuelve = proximaJornada(fecha, h);
    partes.push(
      vuelve
        ? `Ahora está FUERA de horario: lo que derives o prometas confirmar lo verán ${vuelve}. Dilo así ("${vuelve}"); nunca "a la brevedad", "en un momento" ni "hoy mismo".`
        : 'Ahora está en horario: lo que derives o prometas confirmar puede verse hoy mismo.',
    );
  }
  return `\n\n${partes.join(' ')}`;
}
