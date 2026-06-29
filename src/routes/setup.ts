import type { Request, Response } from 'express';
import { getState, setBotId } from '../store';
import { registerBot, unregisterBot } from '../bot/register';
import { callBitrix } from '../bitrix/client';
import { log } from '../log';

/** Lista las etapas (STAGE_ID) de los embudos de Deal, para configurar BITRIX_STAGE_SCORE_*. */
export async function listDealStages(_req: Request, res: Response) {
  const st = await getState();
  if (!st.auth) return res.status(400).json({ ok: false, error: 'No hay auth. Instala el app primero.' });
  try {
    const r: any = await callBitrix('crm.status.list', { order: { SORT: 'ASC' } }, st.auth);
    const all: any[] = Array.isArray(r) ? r : (r?.result ?? []);
    const stages = all
      .filter((s) => String(s.ENTITY_ID).startsWith('DEAL_STAGE'))
      .map((s) => ({ ENTITY_ID: s.ENTITY_ID, STATUS_ID: s.STATUS_ID, NAME: s.NAME }));
    res.json({ ok: true, stages });
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
