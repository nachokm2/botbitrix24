import type { Request, Response } from 'express';
import { getState, setBotId } from '../store';
import { registerBot, unregisterBot } from '../bot/register';
import { callBitrix } from '../bitrix/client';
import { log } from '../log';

/** Lista las etapas (STAGE_ID) de cada embudo de Deal + diagnóstico, para configurar BITRIX_STAGE_SCORE_*. */
export async function listDealStages(_req: Request, res: Response) {
  const st = await getState();
  if (!st.auth) return res.status(400).json({ ok: false, error: 'No hay auth. Instala el app primero.' });

  const debug: any = {};
  const stages: any[] = [];

  // 1) Embudos (categorías) de deal.
  let categoryIds: number[] = [0];
  try {
    const c: any = await callBitrix('crm.category.list', { entityTypeId: 2 }, st.auth);
    debug.categoryListRaw = c;
    const list: any[] = c?.categories ?? (Array.isArray(c) ? c : []);
    categoryIds = Array.from(new Set([0, ...list.map((x: any) => Number(x.id))]));
  } catch (e) {
    debug.categoryListError = String(e);
  }
  debug.categoryIds = categoryIds;

  // 2) Método A: crm.status.list por ENTITY_ID.
  debug.statusList = [];
  for (const id of categoryIds) {
    const entityId = id === 0 ? 'DEAL_STAGE' : `DEAL_STAGE_${id}`;
    try {
      const r: any = await callBitrix('crm.status.list', { filter: { ENTITY_ID: entityId } }, st.auth);
      const arr: any[] = Array.isArray(r) ? r : (r?.result ?? []);
      debug.statusList.push({ entityId, count: arr.length });
      for (const s of arr) stages.push({ categoryId: id, STATUS_ID: s.STATUS_ID, NAME: s.NAME });
    } catch (e) {
      debug.statusList.push({ entityId, error: String(e) });
    }
  }

  // 3) Método B (fallback): crm.dealcategory.stage.list.
  if (stages.length === 0) {
    debug.dealcategoryStage = [];
    for (const id of categoryIds) {
      try {
        const r: any = await callBitrix('crm.dealcategory.stage.list', { id }, st.auth);
        const arr: any[] = Array.isArray(r) ? r : (r?.result ?? r?.stages ?? []);
        debug.dealcategoryStage.push({ id, count: arr.length, sample: arr.slice(0, 1) });
        for (const s of arr) stages.push({ categoryId: id, STATUS_ID: s.STATUS_ID, NAME: s.NAME });
      } catch (e) {
        debug.dealcategoryStage.push({ id, error: String(e) });
      }
    }
  }

  res.json({ ok: true, total: stages.length, stages, debug });
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
