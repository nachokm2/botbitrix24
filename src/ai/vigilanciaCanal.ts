import { callBitrix } from '../bitrix/client';
import { dbMinutosDesdeUltimoTurno } from '../store/db';
import { getState } from '../store';
import { once } from '../store/kv';
import { config } from '../config';
import { marca } from '../marca';
import { audit } from '../obs/audit';
import { horaEnChile } from './seguimiento';
import { log } from '../log';

/**
 * Alarma de silencio: avisa cuando el bot deja de recibir mensajes.
 *
 * El bot de Postgrados estuvo cinco días sin recibir un solo mensaje y nadie se enteró; se descubrió
 * de casualidad revisando otra cosa. No había fallado el código ni el servidor —el canal de WhatsApp
 * dejó de entregar—, y por eso no saltó ninguna alerta: todo lo que vigilábamos seguía sano.
 *
 * Esto vigila la señal que de verdad importa: que siga entrando conversación. Solo mira en horario
 * hábil, porque de madrugada el silencio es lo normal y una alarma que grita todas las noches se
 * ignora a la semana.
 */

/** A quién avisarle. Preferimos el supervisor; si no está, el punto de entrada único de la marca. */
export function destinatarioAlerta(): number {
  return config.derivacionSupervisorId || config.derivarATodo || config.responsablesPorDefecto[0] || 0;
}

/** ¿Estamos dentro del horario en que SÍ se espera actividad? */
function enHorarioHabil(fecha = new Date()): boolean {
  const h = horaEnChile(fecha);
  return h >= config.seguimientoHoraInicio && h < config.seguimientoHoraFin;
}

export type EstadoCanal = { minutos: number | null; silencioso: boolean; umbralMin: number };

/** Mira el estado sin avisar: lo usa el panel y las pruebas. */
export async function estadoCanal(): Promise<EstadoCanal> {
  const minutos = await dbMinutosDesdeUltimoTurno();
  const umbralMin = config.canalSilencioHoras * 60;
  return { minutos, silencioso: minutos !== null && minutos >= umbralMin, umbralMin };
}

/** Revisa y avisa UNA vez por episodio de silencio (no cada hora). */
export async function revisarSilencioCanal(): Promise<EstadoCanal & { aviso: boolean }> {
  const estado = await estadoCanal();
  if (!estado.silencioso || !enHorarioHabil()) return { ...estado, aviso: false };

  const destino = destinatarioAlerta();
  if (!destino) {
    log.warn('canal en silencio pero no hay a quién avisarle', estado as any);
    return { ...estado, aviso: false };
  }
  // Un aviso por día: el canal puede seguir callado muchas horas y repetirlo no agrega información.
  const dia = new Date().toISOString().slice(0, 10);
  if (!(await once(`canal:silencio:${dia}`, 36 * 3600))) return { ...estado, aviso: false };

  const horas = Math.round((estado.minutos ?? 0) / 60);
  const st = await getState();
  if (!st.auth) return { ...estado, aviso: false };
  const texto =
    `[B]El asistente de ${marca.etiquetaPanel} no recibe mensajes hace ${horas} h[/B]\n` +
    'No es una falla del servicio: sigue en línea. Lo habitual es que el canal de WhatsApp haya ' +
    'dejado de entregar, o que lo que enviaba contactos a ese número se haya detenido. ' +
    'Conviene escribirle al número desde un teléfono para comprobarlo.';
  await callBitrix('im.notify.personal.add', { USER_ID: destino, MESSAGE: texto }, st.auth).catch((e) =>
    log.warn('alarma de silencio: no se pudo notificar', { err: String(e) }),
  );
  await audit({ type: 'canal_en_silencio', detail: { horas, destino } });
  log.warn('canal en silencio: aviso enviado', { horas, destino });
  return { ...estado, aviso: true };
}

let intervalo: ReturnType<typeof setInterval> | null = null;
const CHEQUEO_MIN = 30;

export function iniciarVigilanciaCanal(): void {
  if (config.canalSilencioHoras <= 0 || intervalo) return;
  intervalo = setInterval(() => {
    revisarSilencioCanal().catch((e) => log.warn('revisarSilencioCanal falló', { err: String(e) }));
  }, CHEQUEO_MIN * 60_000);
  intervalo.unref();
  log.info('vigilancia del canal activa', { silencioHoras: config.canalSilencioHoras, destino: destinatarioAlerta() });
}
