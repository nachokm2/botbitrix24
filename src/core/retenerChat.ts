import { marca } from '../marca';
import { equipoTrabajando, proximaJornada } from './momento';

/**
 * Cuándo el bot se queda con la conversación en vez de entregársela a una persona.
 *
 * Derivar entrega la sesión de Open Lines a la asesora y el bot se calla. En horario está bien. Un
 * sábado no: el 31-10-2026 el bot derivó cuatro conversaciones a una asesora que volvía el lunes, y
 * desde ese momento nadie respondió. Dos de esas personas estaban llenando la ficha de matrícula en
 * el chat: una siguió mandando sus datos y escribió "la idea es iniciar en noviembre", sin respuesta.
 *
 * Fuera del horario del equipo, la derivación deja a la asesora la negociación y su tarea, y el bot
 * sigue atendiendo. A mitad de la ficha de matrícula, el puntaje alto tampoco entrega la sesión: el
 * bot es quien la está completando, y cortarla ahí es perder a la persona en el último paso.
 */

export type MotivoRetencion = 'fuera_de_horario' | 'ficha_en_curso';

/** Por qué el bot NO debe entregar la conversación ahora, o null si puede entregarla. */
export function motivoParaRetener(opts: { fichaEnCurso?: boolean; ahora?: Date } = {}): MotivoRetencion | null {
  if (!marca.retieneFueraDeHorario) return null;
  if (opts.fichaEnCurso) return 'ficha_en_curso';
  if (!equipoTrabajando(opts.ahora)) return 'fuera_de_horario';
  return null;
}

/** Cuándo vuelve el equipo, dicho para el cliente. */
export function cuandoVuelveElEquipo(ahora?: Date): string {
  return proximaJornada(ahora) ?? 'en el próximo día hábil';
}

/** ¿La ficha de matrícula se empezó a llenar en esta conversación y todavía no está completa? Lo
 *  dice la última respuesta de registrar_datos_matricula que haya en el historial. */
export function fichaDeMatriculaEnCurso(historial: any[]): boolean {
  const ids = new Set<string>();
  for (const m of historial ?? []) {
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const b of m.content) if (b?.type === 'tool_use' && b.name === 'registrar_datos_matricula') ids.add(String(b.id));
  }
  if (!ids.size) return false;
  let completo: boolean | null = null;
  for (const m of historial) {
    if (m?.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b?.type !== 'tool_result' || !ids.has(String(b.tool_use_id))) continue;
      try {
        completo = JSON.parse(typeof b.content === 'string' ? b.content : JSON.stringify(b.content))?.completo === true;
      } catch {
        completo = false;
      }
    }
  }
  return completo !== true;
}
