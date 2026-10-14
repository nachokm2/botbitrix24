import { callBitrix, callCrm } from '../bitrix/client';
import { config } from '../config';
import { getRedisClient } from '../store/kv';
import { getState, type Auth } from '../store';
import { dbHuboOperadorDespuesDe } from '../store/db';
import { audit } from '../obs/audit';
import { esUrgente } from './urgencia';
import { log } from '../log';

/**
 * Vigila que alguien RECOJA lo que el bot deriva.
 *
 * El hallazgo que motivó esto: de 38 casos derivados en el piloto de Postgrados, 4 fueron tomados
 * por una persona. El bot entregaba y nadie se enteraba si el caso quedaba abandonado — el barrido
 * automático lo pasaba a Remarketing semanas después y ahí moría. Era el único tramo roto del
 * embudo, y el más caro: son clientes que ya habían levantado la mano.
 *
 * Dos avisos, por notificación interna de Bitrix:
 *   - A las DERIVACION_ALERTA_HORAS, al responsable de la negociación.
 *   - A las DERIVACION_ALERTA_SUPERVISOR_HORAS, al supervisor (si está configurado).
 * Un caso ya atendido deja de vigilarse: no se molesta a quien sí hizo su trabajo.
 */

const VIGILANCIA_KEY = 'derivacion:vigilancia';
const DATOS_KEY = (dealId: number) => `derivacion:datos:${dealId}`;
const TTL_DATOS_SEG = 15 * 24 * 3600;
const REINTENTO_MS = 30 * 60_000; // Bitrix caído: se reintenta, no se descarta el caso

type DatosVigilancia = { dialogId: string; derivadoEn: number; etapa: 1 | 2; urgente?: boolean };

/** Programa el primer aviso para una negociación recién derivada. Idempotente: si ya está vigilada,
 *  no reinicia el reloj (una segunda derivación del mismo caso no da más plazo). */
export async function vigilarDerivacion(dealId: number, dialogId: string): Promise<void> {
  const r = getRedisClient();
  if (!r || config.derivacionAlertaHoras <= 0 || !dealId) return;
  try {
    if (await r.zscore(VIGILANCIA_KEY, String(dealId))) return;
    // Un caso escalado por puntaje alto no espera lo mismo: la persona mostró interés claro y ya
    // dejó sus datos, así que a las cuatro horas el momento ya pasó. Se le da un plazo más corto.
    const urgente = await esUrgente(dealId);
    const horas = urgente && config.derivacionAlertaUrgenteHoras > 0
      ? Math.min(config.derivacionAlertaUrgenteHoras, config.derivacionAlertaHoras)
      : config.derivacionAlertaHoras;
    const ahora = Date.now();
    await r.zadd(VIGILANCIA_KEY, ahora + horas * 3600_000, String(dealId));
    await r.set(
      DATOS_KEY(dealId),
      JSON.stringify({ dialogId, derivadoEn: ahora, etapa: 1, urgente } satisfies DatosVigilancia),
      'EX',
      TTL_DATOS_SEG,
    );
    log.info('derivación bajo vigilancia', { dealId, horas, urgente });
  } catch (e) {
    log.warn('vigilarDerivacion falló', { err: String(e), dealId });
  }
}

/** ¿Alguien de carne y hueso tocó el caso después de derivarlo? Dos señales, por separado porque
 *  ninguna sola alcanza: un asesor puede responder en el chat SIN mover la etapa, o mover la etapa
 *  sin escribir. Devuelve 'desconocido' si Bitrix no contesta, para reintentar en vez de decidir mal. */
async function fueAtendido(dealId: number, datos: DatosVigilancia, auth: Auth): Promise<'si' | 'no' | 'desconocido'> {
  if (await dbHuboOperadorDespuesDe(datos.dialogId, new Date(datos.derivadoEn))) return 'si';
  try {
    const d: any = await callCrm('crm.deal.get', { id: dealId, select: ['MOVED_BY_ID', 'MOVED_TIME'] }, auth);
    const quien = Number(d?.MOVED_BY_ID ?? 0);
    const cuando = d?.MOVED_TIME ? new Date(d.MOVED_TIME).getTime() : 0;
    if (!quien || !cuando) return 'no';
    if (config.usuariosAutomaticos.includes(quien)) return 'no'; // el barrido a RMKT no es atención
    return cuando > datos.derivadoEn ? 'si' : 'no';
  } catch (e) {
    log.warn('fueAtendido: no se pudo leer la negociación', { err: String(e), dealId });
    return 'desconocido';
  }
}

async function avisar(
  userId: number,
  dealId: number,
  horas: number,
  esSupervisor: boolean,
  auth: Auth,
  urgente = false,
): Promise<void> {
  const url = `https://${auth.domain}/crm/deal/details/${dealId}/`;
  const prefijo = urgente ? '🔥 ' : '';
  const nota = urgente
    ? '\nEste caso lo escaló el asistente por puntaje alto: la persona mostró interés claro y ya dejó sus datos.'
    : '';
  const texto = esSupervisor
    ? `[B]${prefijo}Caso derivado sin tomar hace ${horas} h[/B]\nLa negociación [URL=${url}]#${dealId}[/URL] se derivó hace ${horas} horas y nadie la ha trabajado todavía.${nota}`
    : `[B]${prefijo}Tiene un caso derivado sin responder[/B]\nEl asistente le derivó la negociación [URL=${url}]#${dealId}[/URL] hace ${horas} horas y aún no registra actividad. El cliente ya mostró interés.${nota}`;
  await callBitrix('im.notify.personal.add', { USER_ID: userId, MESSAGE: texto }, auth);
}

/** Barrido: avisa por las derivaciones vencidas que nadie tomó. */
export async function barrerVigilanciaDerivaciones(): Promise<void> {
  const r = getRedisClient();
  if (!r || config.derivacionAlertaHoras <= 0) return;
  let vencidos: string[] = [];
  try {
    vencidos = await r.zrangebyscore(VIGILANCIA_KEY, '-inf', Date.now());
  } catch (e) {
    log.warn('barrerVigilanciaDerivaciones: zrangebyscore falló', { err: String(e) });
    return;
  }
  if (!vencidos.length) return;
  const st = await getState();
  if (!st.auth) return;

  for (const idTexto of vencidos) {
    const dealId = Number(idTexto);
    // Reclama el turno con el ZREM, igual que el resto de los barridos: solo una instancia recibe 1,
    // así que dos procesos no mandan el mismo aviso dos veces. Lo que siga vivo se reprograma abajo.
    const reclamado = await r.zrem(VIGILANCIA_KEY, idTexto).catch(() => 0);
    if (!reclamado) continue;
    try {
      const crudo = await r.get(DATOS_KEY(dealId));
      if (!crudo) continue;
      const datos = JSON.parse(crudo) as DatosVigilancia;

      const atendido = await fueAtendido(dealId, datos, st.auth);
      if (atendido === 'si') continue; // alguien lo tomó: deja de vigilarse
      if (atendido === 'desconocido') {
        // Bitrix no contestó (token vencido, caída). Ante la duda no se avisa, pero tampoco se tira
        // el caso: vuelve a la cola en media hora. Sin esto, una caída borraba toda la vigilancia.
        await r.zadd(VIGILANCIA_KEY, Date.now() + REINTENTO_MS, idTexto);
        continue;
      }

      const horas = Math.round((Date.now() - datos.derivadoEn) / 3600_000);
      const d: any = await callCrm('crm.deal.get', { id: dealId, select: ['ASSIGNED_BY_ID'] }, st.auth);
      const responsable = Number(d?.ASSIGNED_BY_ID ?? 0);
      const destino = datos.etapa === 1 ? responsable : config.derivacionSupervisorId;

      if (destino) {
        await avisar(destino, dealId, horas, datos.etapa === 2, st.auth, Boolean(datos.urgente));
        await audit({
          type: 'derivacion_sin_tomar',
          crmEntity: `deal#${dealId}`,
          dialogId: datos.dialogId,
          detail: { horas, avisadoA: destino, etapa: datos.etapa },
        });
        log.info('vigilanciaDerivaciones: aviso enviado', { dealId, destino, horas, etapa: datos.etapa });
      }

      // Primera etapa cumplida: se reprograma para el supervisor. Segunda: se deja de insistir.
      if (datos.etapa === 1 && config.derivacionSupervisorId && config.derivacionAlertaSupervisorHoras > 0) {
        const cuando = datos.derivadoEn + config.derivacionAlertaSupervisorHoras * 3600_000;
        await r.zadd(VIGILANCIA_KEY, Math.max(cuando, Date.now() + 60_000), idTexto);
        await r.set(DATOS_KEY(dealId), JSON.stringify({ ...datos, etapa: 2 }), 'EX', TTL_DATOS_SEG);
      }
    } catch (e) {
      // Ya salió de la cola: no se reintenta. Perder un aviso es preferible a insistirle a alguien.
      log.warn('barrerVigilanciaDerivaciones: falló para una negociación', { err: String(e), dealId });
    }
  }
}
