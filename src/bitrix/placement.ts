import { callBitrix } from './client';
import { config } from '../config';
import { marca } from '../marca';
import { log } from '../log';
import type { Auth } from '../store';

// Registra el panel del agente como una página DENTRO de Bitrix24 (placement.bind).
// Por defecto en el menú izquierdo (LEFT_MENU); configurable con BITRIX_PLACEMENT.
// Doc: https://apidocs.bitrix24.com/api-reference/widgets/placement/placement-bind.html

const PLACEMENT = process.env.BITRIX_PLACEMENT || 'LEFT_MENU';

/** Enlaza una página del app (por su ruta) como ítem dentro de Bitrix24. */
async function bindPage(
  auth: Auth,
  path: string,
  title: string,
  description: string,
): Promise<{ ok: boolean; placement: string; handler?: string; error?: string }> {
  if (!config.baseUrl) {
    return { ok: false, placement: PLACEMENT, error: 'BASE_URL vacío: no se puede fijar el handler' };
  }
  // Propaga el token del panel en la URL del placement (?k=) para que el iframe autentique sus fetch.
  const tokenQs = config.dashboardToken ? `?k=${encodeURIComponent(config.dashboardToken)}` : '';
  const handler = `${config.baseUrl}${path}${tokenQs}`;
  // El token viaja solo a Bitrix. En el log y en lo que se devuelve va tapado: antes quedaba entero en
  // los logs de Railway (cada instalación y cada /setup/bind-*), y con él se leen todas las
  // conversaciones del panel.
  const handlerVisible = tokenQs ? `${config.baseUrl}${path}?k=***` : handler;
  try {
    await callBitrix('placement.bind', { PLACEMENT, HANDLER: handler, TITLE: title, DESCRIPTION: description }, auth);
    log.info('placement.bind OK', { placement: PLACEMENT, handler: handlerVisible });
    return { ok: true, placement: PLACEMENT, handler: handlerVisible };
  } catch (e) {
    // Por si la descripción de error de Bitrix repite el HANDLER.
    const err = tokenQs ? String(e).split(tokenQs).join('?k=***') : String(e);
    if (/already/i.test(err)) {
      log.info('placement ya estaba enlazado', { placement: PLACEMENT, handler: handlerVisible });
      return { ok: true, placement: PLACEMENT, handler: handlerVisible }; // idempotente
    }
    log.warn('placement.bind falló', { placement: PLACEMENT, err });
    return { ok: false, placement: PLACEMENT, handler: handlerVisible, error: err };
  }
}

// El título lleva la marca porque Postgrados y Carver conviven en el MISMO portal de Bitrix: con el
// título fijo, instalar la segunda app dejaba dos ítems de menú llamados igual y no había forma de
// saber cuál panel se estaba abriendo.
export function bindDashboard(auth: Auth) {
  return bindPage(auth, '/app', `Agente ${marca.etiquetaPanel}`, `Panel de métricas del asistente de IA · ${marca.organizacion}`);
}

export function bindCalls(auth: Auth) {
  return bindPage(auth, '/calls', 'Analítica de Llamadas', 'Historial y KPIs de telefonía (Bitrix24)');
}

export async function unbindDashboard(auth: Auth): Promise<void> {
  if (!config.baseUrl) return;
  try {
    const tokenQs = config.dashboardToken ? `?k=${encodeURIComponent(config.dashboardToken)}` : '';
    await callBitrix('placement.unbind', { PLACEMENT, HANDLER: `${config.baseUrl}/app${tokenQs}` }, auth);
  } catch (e) {
    log.warn('placement.unbind falló', { err: String(e) });
  }
}
