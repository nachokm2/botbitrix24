import { callBitrix } from './client';
import { config } from '../config';
import { log } from '../log';
import type { Auth } from '../store';

// Registra el panel del agente como una página DENTRO de Bitrix24 (placement.bind).
// Por defecto en el menú izquierdo (LEFT_MENU); configurable con BITRIX_PLACEMENT.
// Doc: https://apidocs.bitrix24.com/api-reference/widgets/placement/placement-bind.html

const PLACEMENT = process.env.BITRIX_PLACEMENT || 'LEFT_MENU';

export async function bindDashboard(auth: Auth): Promise<{ ok: boolean; placement: string; handler?: string; error?: string }> {
  if (!config.baseUrl) {
    return { ok: false, placement: PLACEMENT, error: 'BASE_URL vacío: no se puede fijar el handler del panel' };
  }
  const handler = `${config.baseUrl}/app`;
  try {
    await callBitrix(
      'placement.bind',
      {
        PLACEMENT,
        HANDLER: handler,
        TITLE: 'Agente Postgrados',
        DESCRIPTION: 'Panel de métricas del asistente de IA',
      },
      auth,
    );
    log.info('placement.bind OK', { placement: PLACEMENT, handler });
    return { ok: true, placement: PLACEMENT, handler };
  } catch (e) {
    const err = String(e);
    // Si ya estaba enlazado, lo tomamos como éxito idempotente.
    if (/already/i.test(err)) {
      log.info('placement ya estaba enlazado', { placement: PLACEMENT });
      return { ok: true, placement: PLACEMENT, handler };
    }
    log.warn('placement.bind falló', { placement: PLACEMENT, err });
    return { ok: false, placement: PLACEMENT, handler, error: err };
  }
}

export async function unbindDashboard(auth: Auth): Promise<void> {
  if (!config.baseUrl) return;
  try {
    await callBitrix('placement.unbind', { PLACEMENT, HANDLER: `${config.baseUrl}/app` }, auth);
  } catch (e) {
    log.warn('placement.unbind falló', { err: String(e) });
  }
}
