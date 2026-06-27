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
    // finish=true → la página llama BX24.installFinish() para FINALIZAR la instalación.
    // Sin esto, Bitrix NO entrega los eventos del bot al handler.
    return res.send(
      page(
        `✅ PoC instalado y finalizado. Bot de Open Lines registrado (BOT_ID=${botId}).<br><br>` +
          `Ya puedes probar: inicia una conversación NUEVA en el canal y el bot debería responder.`,
        true,
      ),
    );
  } catch (e) {
    log.error('install: error registrando bot', { err: String(e) });
    return res.status(500).send(page(`❌ Error registrando el bot: ${String(e)}`));
  }
}

function page(msg: string, finish = false) {
  // Carga el SDK JS de Bitrix24. En el iframe de instalación, BX24.installFinish()
  // marca la instalación como COMPLETA (requisito para que se entreguen los eventos del bot).
  return `<!doctype html>
<html><head><meta charset="utf-8">
<script src="//api.bitrix24.com/api/v1/"></script>
</head>
<body style="font-family:system-ui,sans-serif;padding:2rem;line-height:1.5">
${msg}
${finish ? `<script>try{BX24.init(function(){BX24.installFinish();});}catch(e){console.error(e);}</script>` : ''}
</body></html>`;
}
