import type { Request, Response } from 'express';
import { extractAuth } from '../bitrix/auth';
import { callBitrix } from '../bitrix/client';
import { exchangeCode } from '../bitrix/refresh';
import { registerBot } from '../bot/register';
import { bindDashboard } from '../bitrix/placement';
import { setAuth, setBotId, setAppToken } from '../store';
import { config } from '../config';
import { marca } from '../marca';
import { log } from '../log';
import { escaparHtml } from '../util/html';

/**
 * Handler de instalación del app local. Bitrix lo llama al instalar (con auth).
 * Guarda el auth y registra el bot de Open Lines.
 */
export async function installHandler(req: Request, res: Response) {
  let auth = extractAuth(req);

  // Camino alternativo: Bitrix redirige acá con ?code= tras aprobar la autorización. Se usa cuando
  // la instalación normal del app local no llega a ocurrir — en el portal de Carver, Bitrix
  // respondía "Aplicación reinstalada" sin abrir nunca esta ruta (0 peticiones al servidor). Acá el
  // navegador SÍ nos visita, con el código, y lo canjeamos por los tokens.
  const code = typeof req.query?.code === 'string' ? req.query.code : '';
  if (!auth && code) {
    try {
      // Bitrix IGNORA el redirect_uri que se le pase en /oauth/authorize y redirige siempre a la
      // ruta del controlador del app (/app). El canje exige que el redirect_uri coincida con esa
      // redirección real, así que se arma desde la ruta por la que entró la petición.
      auth = await exchangeCode(code, `${config.baseUrl}${req.path}`);
      log.info('install: auth obtenido por canje de código OAuth', { domain: auth.domain });
    } catch (e) {
      log.error('install: no se pudo canjear el código', { err: String(e) });
      // Escapado: el texto del error viene de fuera (la respuesta de OAuth) y esta página es HTML.
      return res.status(400).send(page(`❌ No se pudo canjear el código de autorización:<br><code>${escaparHtml(e)}</code>`));
    }
  }

  if (!auth || !auth.domain || !auth.access_token) {
    log.warn('install: sin auth válido', { bodyKeys: Object.keys(req.body ?? {}) });
    return res.status(400).send(page('❌ No se recibió auth de Bitrix24.'));
  }

  // Solo el portal propio. Esta ruta no exige autenticación porque la llama Bitrix al instalar, y antes
  // guardaba las credenciales de CUALQUIER dominio que viniera en el cuerpo y después le hacía
  // peticiones a ese dominio, incluido placement.bind con el DASHBOARD_TOKEN en la URL. Así cualquiera
  // podía reemplazar el estado del app, quedarse con el token del panel y —sin BITRIX_APPLICATION_TOKEN,
  // como en Carver— cambiar el token que verifica los eventos y dejar sordo al bot.
  const dominio = typeof auth.domain === 'string' ? auth.domain.trim().toLowerCase() : '';
  if (!config.bitrixPortalDomain) {
    if (process.env.NODE_ENV === 'production') {
      log.error('install: sin BITRIX_PORTAL_DOMAIN ni BITRIX_WEBHOOK_URL no se puede validar el portal');
      return res.status(503).send(page('❌ Portal de Bitrix24 no configurado.'));
    }
    log.warn('install: sin portal configurado; se acepta solo fuera de producción', { dominio });
  } else if (dominio !== config.bitrixPortalDomain) {
    log.warn('install: portal no autorizado', { dominio });
    return res.status(403).send(page('❌ Portal no autorizado.'));
  }

  // Y el token tiene que funcionar en ese portal ANTES de guardar nada: es lo que Bitrix recomienda para
  // la instalación (verificar el access_token y recién entonces retener el application_token).
  try {
    await callBitrix('app.info', {}, auth);
  } catch (e) {
    log.warn('install: el token no funciona en el portal', { dominio, err: String(e) });
    return res.status(401).send(page('❌ Credenciales de Bitrix24 no válidas.'));
  }

  // application_token de esta instalación: se usa para verificar el origen de los eventos posteriores.
  // Solo si es texto: el parser urlencoded puede entregarlo como objeto (qs con allowPrototypes).
  const appTokenCrudo = (req.body as any)?.auth?.application_token ?? (req.body as any)?.application_token;
  const appToken = typeof appTokenCrudo === 'string' ? appTokenCrudo : '';
  if (config.bitrixAppToken && appToken && appToken !== config.bitrixAppToken) {
    log.warn('install: application_token no coincide con BITRIX_APPLICATION_TOKEN');
    return res.status(401).send(page('❌ application_token inválido.'));
  }

  if (!auth.domain && typeof req.query?.domain === 'string') auth.domain = req.query.domain;
  await setAuth(auth);
  if (appToken) await setAppToken(appToken);

  try {
    const botId = await registerBot(auth);
    await setBotId(botId);
    log.info('install: bot registrado', { botId, domain: auth.domain });

    // Registra el panel de métricas como página dentro de Bitrix24 (no crítico).
    const panel = await bindDashboard(auth);
    log.info('install: bindDashboard', panel);
    // finish=true → la página llama BX24.installFinish() para FINALIZAR la instalación.
    // Sin esto, Bitrix NO entrega los eventos del bot al handler.
    return res.send(
      page(
        `✅ PoC instalado y finalizado. Bot de Open Lines registrado (BOT_ID=${botId}).<br>` +
          // El nombre sale de la marca, igual que el del placement: estaba fijo en "Agente Postgrados"
          // y en la instalación de Carver el mensaje decía un nombre distinto del que quedó en el menú.
          `Panel de métricas: ${panel.ok ? `✅ agregado al menú («Agente ${marca.etiquetaPanel}»)` : '⚠️ no se pudo enlazar (' + escaparHtml(panel.error ?? '') + ') — reintenta en /setup/bind-dashboard'}.<br><br>` +
          `Ya puedes probar: inicia una conversación NUEVA en el canal y el bot debería responder.`,
        true,
      ),
    );
  } catch (e) {
    log.error('install: error registrando bot', { err: String(e) });
    return res.status(500).send(page(`❌ Error registrando el bot: ${escaparHtml(e)}`));
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

/**
 * Middleware para la ruta del controlador (/app): si Bitrix redirigió ahí con ?code=, completa la
 * instalación en vez de intentar abrir el panel. Sin esto, la autorización terminaba en un
 * {"ok":false,"error":"unauthorized"} del guardia de token, con el código OAuth ya en la URL.
 *
 * Devuelve la promesa de la instalación (antes la descartaba con `void`) para que manejarAsync capture
 * su rechazo: descartada, un error en la instalación quedaba sin manejar y Node terminaba el proceso.
 */
export function oauthCodeOrNext(req: Request, res: Response, next: () => void) {
  if (typeof req.query?.code === 'string' && req.query.code) return installHandler(req, res);
  next();
}
