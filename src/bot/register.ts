import { callBitrix } from '../bitrix/client';
import { config } from '../config';
import { log } from '../log';
import type { Auth } from '../store';

/**
 * Registra el chatbot de Open Lines (TYPE='O'). Bitrix invocará EVENT_MESSAGE_ADD
 * (nuestro handler) en cada mensaje del cliente dentro del canal abierto.
 * Devuelve el BOT_ID.
 */
export async function registerBot(auth: Auth): Promise<number> {
  // Bitrix exige URLs de handler HTTPS absolutas. Si BASE_URL falta, el registro falla
  // con "Wrong handler URL". Validamos antes para dar un mensaje claro.
  if (!/^https:\/\/[^/]+/.test(config.baseUrl)) {
    throw new Error(
      `BASE_URL inválida o vacía ("${config.baseUrl}"). ` +
        `Define BASE_URL=https://botbitrix24-production.up.railway.app en Railway (sin slash final) y redeploya.`,
    );
  }
  const handler = `${config.baseUrl}/events/bot/message`;
  log.info('registrando bot', { handler, code: config.botCode });

  const res = await callBitrix<number | string>(
    'imbot.register',
    {
      CODE: config.botCode,
      TYPE: 'O',
      OPENLINE: 'Y',
      EVENT_MESSAGE_ADD: `${config.baseUrl}/events/bot/message`,
      EVENT_WELCOME_MESSAGE: `${config.baseUrl}/events/bot/welcome`,
      EVENT_BOT_DELETE: `${config.baseUrl}/events/bot/delete`,
      PROPERTIES: {
        NAME: 'PoC Asistente Postgrados',
        COLOR: 'AZURE',
        WORK_POSITION: 'Asesor virtual (PoC)',
      },
    },
    auth,
  );
  return Number(res);
}

export async function unregisterBot(auth: Auth, botId: number) {
  return callBitrix('imbot.unregister', { BOT_ID: botId }, auth);
}
