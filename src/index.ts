import express from 'express';
import { config } from './config';
import { log } from './log';
import { installHandler } from './routes/install';
import { botMessageHandler, botWelcomeHandler, botDeleteHandler } from './routes/botEvents';
import { registerBotManual, unregisterBotManual } from './routes/setup';

const app = express();
// Bitrix envía eventos como x-www-form-urlencoded con claves anidadas (data[PARAMS][...]).
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));

// DIAGNÓSTICO: registra TODA petición entrante (método + ruta + evento si lo trae).
app.use((req, _res, next) => {
  const event = (req.body as any)?.event;
  log.info(`REQ ${req.method} ${req.path}${event ? ` event=${event}` : ''}`);
  next();
});

// Bitrix abre la "Ruta del controlador" (esta URL) por POST al entrar al app → aceptamos ambos.
app.all('/', (_req, res) =>
  res.send(
    `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui,sans-serif;padding:2rem">` +
      `PoC Agente Bitrix24 — funcionando ✅. El bot opera en segundo plano (Open Lines).` +
      `</body>`,
  ),
);
app.get('/health', (_req, res) => res.json({ ok: true, t: new Date().toISOString() }));

// Diagnóstico: confirma qué configuración ve la instancia (sin exponer secretos).
app.get('/debug/config', (_req, res) =>
  res.json({
    baseUrl: config.baseUrl || '(vacío)',
    eventHandler: config.baseUrl ? `${config.baseUrl}/events/bot/message` : '(BASE_URL vacío)',
    model: config.model,
    botCode: config.botCode,
    hasAnthropicKey: Boolean(config.anthropicApiKey),
    hasClientId: Boolean(config.bitrixClientId),
    hasClientSecret: Boolean(config.bitrixClientSecret),
  }),
);

// Instalación del app local (registra el bot)
app.all('/install', installHandler);

// Eventos del bot de Open Lines
app.post('/events/bot/message', botMessageHandler);
app.post('/events/bot/welcome', botWelcomeHandler);
app.post('/events/bot/delete', botDeleteHandler);

// Utilidades de setup manual
app.get('/setup/register-bot', registerBotManual);
app.get('/setup/unregister-bot', unregisterBotManual);

app.listen(config.port, () =>
  log.info('PoC escuchando', { port: config.port, baseUrl: config.baseUrl || '(define BASE_URL)' }),
);
