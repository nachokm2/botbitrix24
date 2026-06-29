import express from 'express';
import { config } from './config';
import { log } from './log';
import { installHandler } from './routes/install';
import { botMessageHandler, botWelcomeHandler, botDeleteHandler } from './routes/botEvents';
import { registerBotManual, unregisterBotManual, listDealStages } from './routes/setup';
import { initDb, dbRecentAudit, dbEnabled } from './store/db';
import { snapshot } from './obs/metrics';
import { kvKind } from './store/kv';

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

// Observabilidad: métricas (JSON) y panel de estadísticas (HTML).
app.get('/metrics', (_req, res) =>
  res.json({ ...snapshot(), kv: kvKind, db: dbEnabled() ? 'postgres' : 'off' }),
);
app.get('/stats', async (_req, res) => {
  const m = snapshot();
  const audits = await dbRecentAudit(25);
  const rows = audits
    .map(
      (a: any) =>
        `<tr><td>${a.ts}</td><td>${a.type}</td><td>${a.dialog_id ?? ''}</td><td>${a.crm_entity ?? ''}</td></tr>`,
    )
    .join('');
  res.send(
    `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui,sans-serif;padding:1.5rem;line-height:1.4">` +
      `<h2>PoC Agente — Observabilidad</h2>` +
      `<p>KV: <b>${kvKind}</b> · DB: <b>${dbEnabled() ? 'postgres' : 'off'}</b> · activo desde ${m.startedAt}</p>` +
      `<h3>Métricas</h3><pre>${JSON.stringify(m, null, 2)}</pre>` +
      `<h3>Auditoría reciente${dbEnabled() ? '' : ' (sin Postgres: solo en logs)'}</h3>` +
      `<table border="1" cellpadding="6" style="border-collapse:collapse"><tr><th>ts</th><th>type</th><th>dialog</th><th>crm</th></tr>${rows}</table>` +
      `</body>`,
  );
});

// Instalación del app local (registra el bot)
app.all('/install', installHandler);

// Eventos del bot de Open Lines
app.post('/events/bot/message', botMessageHandler);
app.post('/events/bot/welcome', botWelcomeHandler);
app.post('/events/bot/delete', botDeleteHandler);

// Utilidades de setup manual
app.get('/setup/register-bot', registerBotManual);
app.get('/setup/unregister-bot', unregisterBotManual);
app.get('/setup/deal-stages', listDealStages);

// Inicializa Postgres (auditoría) en segundo plano; el app funciona mientras conecta.
initDb().catch((e) => log.error('initDb error', { err: String(e) }));

app.listen(config.port, () =>
  log.info('PoC escuchando', { port: config.port, baseUrl: config.baseUrl || '(define BASE_URL)' }),
);
