import type { Request, Response } from 'express';
import { getState, setBotId } from '../store';
import { registerBot, unregisterBot } from '../bot/register';
import { callBitrix, callWebhook } from '../bitrix/client';
import { config } from '../config';
import { log } from '../log';

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
    const c: any = await call('crm.category.list', { entityTypeId: 2 });
    const list: any[] = c?.categories ?? (Array.isArray(c) ? c : []);
    categoryIds = Array.from(new Set([0, ...list.map((x: any) => Number(x.id))]));
    debug.categories = list.map((x: any) => ({ id: x.id, name: x.name }));
  } catch (e) {
    debug.categoryListError = String(e);
  }

  debug.statusList = [];
  for (const id of categoryIds) {
    const entityId = id === 0 ? 'DEAL_STAGE' : `DEAL_STAGE_${id}`;
    try {
      const r: any = await call('crm.status.list', { filter: { ENTITY_ID: entityId } });
      const arr: any[] = Array.isArray(r) ? r : (r?.result ?? []);
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
