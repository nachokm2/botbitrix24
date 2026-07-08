import type { Request, Response } from 'express';
import { getState, setBotId, EMPTY_AUTH } from '../store';
import { registerBot, unregisterBot } from '../bot/register';
import { callBitrix, callWebhook } from '../bitrix/client';
import { getDealAsesores } from '../crm/openlinesCrm';
import { bindDashboard, bindCalls } from '../bitrix/placement';
import { syncCalls } from '../crm/callSync';
import { dbEnabled } from '../store/db';
import { config } from '../config';
import { log } from '../log';
import type { BitrixCategory, BitrixCategoryListResponse, BitrixStatus, BitrixStatusListResponse } from '../bitrix/types';

/** (Re)enlaza el panel de métricas como página dentro de Bitrix24. GET /setup/bind-dashboard */
export async function bindDashboardManual(_req: Request, res: Response) {
  const st = await getState();
  if (!st.auth) return res.status(400).json({ ok: false, error: 'No hay auth. Instala el app (/install) primero.' });
  const r = await bindDashboard(st.auth);
  return res.status(r.ok ? 200 : 500).json(r);
}

/** (Re)enlaza la página de Analítica de Llamadas dentro de Bitrix24. GET /setup/bind-calls */
export async function bindCallsManual(_req: Request, res: Response) {
  const st = await getState();
  if (!st.auth) return res.status(400).json({ ok: false, error: 'No hay auth. Instala el app (/install) primero.' });
  const r = await bindCalls(st.auth);
  return res.status(r.ok ? 200 : 500).json(r);
}

/** Sincroniza las llamadas (voximplant.statistic.get → Postgres) EN SEGUNDO PLANO. GET /setup/sync-calls */
export async function syncCallsManual(_req: Request, res: Response) {
  if (!dbEnabled()) return res.status(400).json({ ok: false, error: 'Postgres desactivado (define DATABASE_URL en Railway).' });
  const st = await getState();
  // Fire-and-forget: el backfill puede tardar minutos; no bloqueamos la respuesta HTTP.
  void syncCalls(st.auth ?? EMPTY_AUTH).then((r) => log.info('sync manual de llamadas', r));
  return res.json({ ok: true, started: true, mensaje: 'Sincronización iniciada en segundo plano. Revisa /calls en unos minutos.' });
}

/** Diagnóstico: trae el responsable (ASSIGNED_BY_ID) y observadores de un deal. GET /setup/deal-responsable?id=NNN */
export async function dealResponsable(req: Request, res: Response) {
  const id = Number(req.query.id);
  if (!id) return res.status(400).json({ ok: false, error: 'Falta ?id=<dealId> (ej. /setup/deal-responsable?id=77)' });
  const st = await getState();
  if (!st.auth && !config.bitrixWebhookUrl) {
    return res.status(400).json({ ok: false, error: 'No hay auth ni BITRIX_WEBHOOK_URL.' });
  }
  try {
    const { responsable, observadores, info } = await getDealAsesores(id, st.auth ?? EMPTY_AUTH);
    res.json({
      ok: true,
      via: config.bitrixWebhookUrl ? 'webhook' : 'app-token',
      dealId: id,
      titulo: info.titulo,
      categoryId: info.categoryId,
      stageId: info.stageId,
      responsable,
      observadores,
      nota: responsable?.nombre?.startsWith('Usuario ')
        ? 'Se obtuvo el ID del responsable pero no su nombre: agrega el scope "user" (Usuarios) al webhook entrante para resolver nombre/email.'
        : undefined,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
}

/** Lista las etapas (STAGE_ID) de cada embudo de Deal + diagnóstico, para configurar BITRIX_STAGE_SCORE_*. */
export async function listDealStages(_req: Request, res: Response) {
  const st = await getState();
  if (!st.auth && !config.bitrixWebhookUrl) {
    return res.status(400).json({ ok: false, error: 'No hay auth ni BITRIX_WEBHOOK_URL. Instala el app o define el webhook.' });
  }

  // El token del bot es no-Intranet (crm.category.list da allowed_only_intranet_user).
  // Si hay un webhook entrante (creado por un admin), úsalo: corre con permisos completos.
  const useWebhook = Boolean(config.bitrixWebhookUrl);
  const call = (method: string, params: any) =>
    useWebhook ? callWebhook(method, params, config.bitrixWebhookUrl) : callBitrix(method, params, st.auth!);

  const debug: any = { via: useWebhook ? 'webhook' : 'app-token' };
  const stages: any[] = [];

  let categoryIds: number[] = [0];
  try {
    const c = (await call('crm.category.list', { entityTypeId: 2 })) as BitrixCategoryListResponse;
    const list: BitrixCategory[] = Array.isArray(c) ? c : (c?.categories ?? []);
    categoryIds = Array.from(new Set([0, ...list.map((x) => Number(x.id))]));
    debug.categories = list.map((x) => ({ id: x.id, name: x.name }));
  } catch (e) {
    debug.categoryListError = String(e);
  }

  debug.statusList = [];
  for (const id of categoryIds) {
    const entityId = id === 0 ? 'DEAL_STAGE' : `DEAL_STAGE_${id}`;
    try {
      const r = (await call('crm.status.list', { filter: { ENTITY_ID: entityId } })) as BitrixStatusListResponse;
      const arr: BitrixStatus[] = Array.isArray(r) ? r : (r?.result ?? []);
      debug.statusList.push({ entityId, count: arr.length });
      for (const s of arr) stages.push({ categoryId: id, STATUS_ID: s.STATUS_ID, NAME: s.NAME });
    } catch (e) {
      debug.statusList.push({ entityId, error: String(e) });
    }
  }

  res.json({ ok: true, via: debug.via, total: stages.length, stages, debug });
}

/** Registro manual del bot (si el auto-registro en /install no se ejecutó). */
export async function registerBotManual(_req: Request, res: Response) {
  const st = await getState();
  if (!st.auth) {
    return res.status(400).json({ ok: false, error: 'No hay auth. Instala el app (/install) primero.' });
  }
  try {
    const botId = await registerBot(st.auth);
    await setBotId(botId);
    log.info('setup: bot registrado', { botId });
    return res.json({ ok: true, botId });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}

/** Limpieza: desregistra el bot. */
export async function unregisterBotManual(_req: Request, res: Response) {
  const st = await getState();
  if (!st.auth || !st.botId) {
    return res.status(400).json({ ok: false, error: 'Falta auth o botId.' });
  }
  try {
    await unregisterBot(st.auth, st.botId);
    log.info('setup: bot desregistrado', { botId: st.botId });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
