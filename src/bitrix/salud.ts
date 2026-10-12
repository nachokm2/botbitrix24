import { callBitrix, callCrm } from './client';
import { getState } from '../store';
import { dbEnviosRecientes } from '../store/db';
import { once } from '../store/kv';
import { config } from '../config';
import { marca } from '../marca';
import { audit } from '../obs/audit';
import { destinatarioAlerta } from '../ai/vigilanciaCanal';
import { log } from '../log';

/**
 * Salud de la integración con Bitrix.
 *
 * Hay DOS caminos hacia Bitrix y fallan por separado, que es lo que los hace traicioneros:
 *
 *  - El webhook de administrador (callCrm): no caduca. Por ahí van las lecturas y escrituras del CRM.
 *  - El token OAuth guardado (callBitrix): caduca y se renueva solo... hasta que la renovación deja
 *    de funcionar. Por ahí van los mensajes del bot, las notificaciones y todo lo PROACTIVO.
 *
 * Cuando el segundo se rompe, las conversaciones siguen andando —cada evento de Bitrix trae su
 * propio token— y el panel se ve bien, pero los seguimientos, los avisos de derivación y el resumen
 * semanal fallan en silencio. Es el estado en que encontramos a Postgrados: refresh con
 * `invalid_grant` desde hacía días y nada que lo dijera.
 */

export type Salud = {
  oauth: 'ok' | 'roto' | 'sin_token';
  webhook: 'ok' | 'roto' | 'no_configurado';
  /** Envíos proactivos de las últimas 24 h. Es lo más cerca de la "salud del número" a la que se
   *  puede llegar: Meta no expone la calificación de calidad a través de ChatApp, pero cuando un
   *  número empieza a ser limitado —o una plantilla deja de estar aprobada— lo que se ve es que los
   *  envíos fallan. */
  envios: { total: number; fallidos: number; tasaFalla: number; errores: string[] };
  detalle?: string;
};

export async function revisarSalud(): Promise<Salud> {
  const envios = await dbEnviosRecientes(24);
  const out: Salud = {
    oauth: 'sin_token',
    webhook: 'no_configurado',
    envios: {
      ...envios,
      tasaFalla: envios.total ? Math.round((envios.fallidos / envios.total) * 100) : 0,
    },
  };
  const st = await getState();

  if (st.auth?.access_token) {
    try {
      // Método barato y sin efectos: solo confirma que el token sirve.
      await callBitrix('user.current', {}, st.auth);
      out.oauth = 'ok';
    } catch (e) {
      out.oauth = 'roto';
      out.detalle = String(e).slice(0, 200);
    }
  }

  if (config.bitrixWebhookUrl) {
    try {
      await callCrm('crm.status.list', { filter: { ENTITY_ID: 'DEAL_STAGE' } }, st.auth ?? ({} as any));
      out.webhook = 'ok';
    } catch (e) {
      out.webhook = 'roto';
      out.detalle = (out.detalle ? out.detalle + ' | ' : '') + String(e).slice(0, 200);
    }
  }
  return out;
}

/** Revisa y avisa si algo está roto. Un aviso por día: el problema dura hasta que alguien lo toca. */
export async function revisarSaludYAvisar(): Promise<Salud & { aviso: boolean }> {
  const salud = await revisarSalud();
  // Un repunte de fallas solo significa algo con volumen: 1 de 1 es ruido, 20 de 40 es un problema.
  const enviosEnProblemas =
    salud.envios.total >= config.enviosMinimoParaAlertar && salud.envios.tasaFalla >= config.enviosTasaFallaAlerta;
  const roto = salud.oauth === 'roto' || salud.webhook === 'roto' || enviosEnProblemas;
  if (!roto) return { ...salud, aviso: false };

  await audit({ type: 'integracion_rota', detail: salud });
  const destino = destinatarioAlerta();
  const st = await getState();
  if (!destino || !st.auth) {
    log.error('integración con Bitrix rota y sin a quién avisarle', salud as any);
    return { ...salud, aviso: false };
  }
  const dia = new Date().toISOString().slice(0, 10);
  if (!(await once(`salud:${dia}`, 36 * 3600))) return { ...salud, aviso: false };

  const texto =
    `[B]La conexión del asistente de ${marca.etiquetaPanel} con Bitrix está fallando[/B]\n` +
    (salud.oauth === 'roto'
      ? 'El permiso de la aplicación dejó de renovarse. Las conversaciones siguen funcionando, pero ' +
        'los seguimientos automáticos, los avisos de derivación y el resumen semanal NO se están ' +
        'enviando. Se corrige reinstalando la aplicación en Bitrix24.\n'
      : '') +
    (salud.webhook === 'roto' ? 'El webhook de administrador no responde: revisar que siga vigente.\n' : '');
  // El aviso sale por el mismo OAuth que puede estar roto; si no llega, queda en auditoría y logs.
  await callBitrix('im.notify.personal.add', { USER_ID: destino, MESSAGE: texto }, st.auth).catch((e) =>
    log.error('salud: tampoco se pudo notificar', { err: String(e) }),
  );
  log.error('integración con Bitrix rota', salud as any);
  return { ...salud, aviso: true };
}

let intervalo: ReturnType<typeof setInterval> | null = null;
const CHEQUEO_MIN = 60;

export function iniciarVigilanciaSalud(): void {
  if (!config.vigilarSalud || intervalo) return;
  intervalo = setInterval(() => {
    revisarSaludYAvisar().catch((e) => log.warn('revisarSaludYAvisar falló', { err: String(e) }));
  }, CHEQUEO_MIN * 60_000);
  intervalo.unref();
  log.info('vigilancia de salud activa', { cadaMin: CHEQUEO_MIN });
}
