import { callBitrix, callCrm } from '../bitrix/client';
import { getDealAsesores } from './directory';
import { esAsesorValido } from './equipo';
import { once, kvDel } from '../store/kv';
import { config } from '../config';
import { audit } from '../obs/audit';
import { log } from '../log';
import type { Auth } from '../store';

/**
 * Aviso directo a la persona que tiene que actuar, sin sacar al bot de la conversación.
 *
 * escalar_a_humano entrega la sesión a la cola: es lo que corresponde cuando el cliente pide una
 * persona, pero deja al bot mudo hasta el lunes si es sábado. Para un pendiente puntual —"le confirmo
 * la acreditación", "quiere pagar ya"— basta con que el responsable de la negociación se entere: una
 * notificación en Bitrix y, si se pide, una tarea. El bot sigue atendiendo mientras tanto.
 *
 * La notificación va por la conexión de la app (la misma con la que el bot contesta), no por el
 * webhook: si el webhook vuelve a bloquearse por sobrecarga, el aviso igual sale. Sin responsable
 * válido —o si leer la negociación falla— va al supervisor, el mismo destino de las alertas del canal.
 */

export type Aviso = {
  /** Clase de aviso, para auditar y para el candado. */
  tipo: 'promesa' | 'pago';
  dialogId: string;
  dealId?: number;
  chatId?: string | number;
  titulo: string;
  detalle: string;
  /** Además de notificar, deja una tarea al responsable (solo si la negociación tiene uno válido). */
  tarea?: boolean;
  /** Mientras dure, no se repite el mismo aviso para el mismo chat. */
  ttlSeg: number;
};

export type ResultadoAviso = { avisado: boolean; destino: number | null; motivo?: string };

// El mismo destino que las alertas del canal (ai/vigilanciaCanal.ts:destinatarioAlerta). No se
// importa de ahí porque ese módulo arrastra ai/seguimiento y cerraría un ciclo con ai/agentLoop.
const supervisor = () => config.derivacionSupervisorId || config.derivarATodo || config.responsablesPorDefecto[0] || 0;

async function responsableValido(dealId: number | undefined, auth: Auth): Promise<number | null> {
  if (!dealId) return null;
  try {
    const { responsable } = await getDealAsesores(dealId, auth);
    return responsable && esAsesorValido(responsable) ? responsable.id : null;
  } catch (e) {
    log.warn('avisoAsesor: no se pudo leer el responsable; se avisa al supervisor', { err: String(e), dealId });
    return null;
  }
}

export async function avisarAlResponsable(a: Aviso, auth: Auth): Promise<ResultadoAviso> {
  const candado = `aviso:${a.tipo}:${a.dialogId}`;
  if (!(await once(candado, a.ttlSeg))) return { avisado: false, destino: null, motivo: 'ya_avisado' };

  const responsable = await responsableValido(a.dealId, auth);
  const destino = responsable ?? (supervisor() || null);
  if (!destino) {
    await kvDel(candado).catch(() => {});
    log.warn('avisoAsesor: no hay a quién avisar', { tipo: a.tipo, dialogId: a.dialogId });
    return { avisado: false, destino: null, motivo: 'sin_destino' };
  }

  const enlaces = [
    a.dealId ? `Negociación: [URL=https://${auth.domain}/crm/deal/details/${a.dealId}/]#${a.dealId}[/URL]` : '',
    a.chatId ? `Chat: [URL=https://${auth.domain}/online/?IM_DIALOG=chat${a.chatId}]abrir conversación[/URL]` : '',
  ].filter(Boolean);
  const texto = [`[B]${a.titulo}[/B]`, a.detalle, ...enlaces].join('\n');
  try {
    await callBitrix('im.notify.personal.add', { USER_ID: destino, MESSAGE: texto }, auth);
  } catch (e) {
    await kvDel(candado).catch(() => {});
    log.warn('avisoAsesor: la notificación no salió', { err: String(e), tipo: a.tipo, destino });
    return { avisado: false, destino, motivo: 'notificacion_fallida' };
  }

  // La tarea queda aunque la notificación se pierda entre otras: es lo que el asesor revisa el lunes.
  if (a.tarea && a.dealId && responsable) {
    try {
      await callCrm(
        'tasks.task.add',
        {
          fields: {
            TITLE: `${a.titulo} — Deal #${a.dealId}`,
            DESCRIPTION: `${a.detalle}\n\nRevisa la conversación en la negociación.`,
            RESPONSIBLE_ID: responsable,
            DEADLINE: new Date(Date.now() + config.asignacionTareaHoras * 3600_000).toISOString(),
            PRIORITY: 2,
            UF_CRM_TASK: [`D_${a.dealId}`],
          },
        },
        auth,
      );
    } catch (e) {
      log.warn('avisoAsesor: no se pudo crear la tarea (la notificación sí salió)', { err: String(e), dealId: a.dealId });
    }
  }

  void audit({
    type: 'aviso_asesor',
    dialogId: a.dialogId,
    crmEntity: a.dealId ? `deal#${a.dealId}` : undefined,
    detail: { tipo: a.tipo, destino, alSupervisor: !responsable },
  }).catch(() => {});
  log.info('avisoAsesor: aviso enviado', { tipo: a.tipo, dialogId: a.dialogId, destino });
  return { avisado: true, destino };
}
