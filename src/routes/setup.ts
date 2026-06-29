import type { Request, Response } from 'express';
import { getState, setBotId } from '../store';
import { registerBot, unregisterBot } from '../bot/register';
import { callBitrix } from '../bitrix/client';
import { log } from '../log';

/** Lista las etapas (STAGE_ID) de cada embudo de Deal, para configurar BITRIX_STAGE_SCORE_*. */
export async function listDealStages(_req: Request, res: Response) {
  const st = await getState();
  if (!st.auth) return res.status(400).json({ ok: false, error: 'No hay auth. Instala el app primero.' });
  try {
    // 1) Embudos (categorías) de deal. Siempre incluimos el General (id 0).
    const cats = new Map<number, string>([[0, 'General']]);
    try {
      const c: any = await callBitrix('crm.category.list', { entityTypeId: 2 }, st.auth);
      const list: any[] = c?.categories ?? (Array.isArray(c) ? c : []);
      for (const x of list) cats.set(Number(x.id), String(x.name ?? `Embudo ${x.id}`));
    } catch (e) {
      log.warn('crm.category.list falló (uso solo General)', { err: String(e) });
    }

    // 2) Etapas por embudo (ENTITY_ID = DEAL_STAGE para id 0, DEAL_STAGE_<id> para el resto).
    const stages: any[] = [];
    for (const [id, name] of cats) {
      const entityId = id === 0 ? 'DEAL_STAGE' : `DEAL_STAGE_${id}`;
      try {
        const r: any = await callBitrix('crm.status.list', { filter: { ENTITY_ID: entityId }, order: { SORT: 'ASC' } }, st.auth);
        const arr: any[] = Array.isArray(r) ? r : (r?.result ?? []);
        for (const s of arr) stages.push({ embudo: name, categoryId: id, STATUS_ID: s.STATUS_ID, NAME: s.NAME });
      } catch (e) {
        log.warn('crm.status.list falló', { entityId, err: String(e) });
      }
    }
    res.json({ ok: true, total: stages.length, stages });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
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
