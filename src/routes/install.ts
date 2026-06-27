import type { Request, Response } from 'express';
import { extractAuth } from '../bitrix/auth';
import { registerBot } from '../bot/register';
import { setAuth, setBotId } from '../store';
import { log } from '../log';

/**
 * Handler de instalación del app local. Bitrix lo llama al instalar (con auth).
 * Guarda el auth y registra el bot de Open Lines.
 */
export async function installHandler(req: Request, res: Response) {
  const auth = extractAuth(req);
  if (!auth || !auth.domain || !auth.access_token) {
    log.warn('install: sin auth válido', { bodyKeys: Object.keys(req.body ?? {}) });
    return res.status(400).send(page('❌ No se recibió auth de Bitrix24.'));
  }

  await setAuth(auth);

  try {
    const botId = await registerBot(auth);
    await setBotId(botId);
    log.info('install: bot registrado', { botId, domain: auth.domain });
    return res.send(
      page(
        `✅ PoC instalado. Bot de Open Lines registrado (BOT_ID=${botId}).<br><br>` +
          `Siguiente paso: en el <b>canal de ChatApp</b> configura este bot como primer responder ` +
          `y desactiva el bot propio de ChatApp/ChatGPT.`,
      ),
    );
  } catch (e) {
    log.error('install: error registrando bot', { err: String(e) });
    return res.status(500).send(page(`❌ Error registrando el bot: ${String(e)}`));
  }
}

function page(msg: string) {
  return `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui,sans-serif;padding:2rem;line-height:1.5">${msg}</body>`;
}
