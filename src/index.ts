import express from 'express';
import crypto from 'crypto';
import { fileURLToPath } from 'node:url';
import { config } from './config';
import { log } from './log';
import { runWithRequestContext } from './obs/requestContext';
import { installHandler } from './routes/install';
import { botMessageHandler, botWelcomeHandler, botDeleteHandler } from './routes/botEvents';
import { registerBotManual, unregisterBotManual, listDealStages, dealResponsable, bindDashboardManual, bindCallsManual, syncCallsManual } from './routes/setup';
import { startCallSync } from './crm/callSync';
import { vapiEvents, voiceOutbound, verifyVapiSecret } from './routes/vapi';
import { vapiChatCompletions } from './routes/vapiLlm';
import { webchatMessage, webchatPage } from './routes/webchat';
import { metaVerify, verifyMetaSignature, metaWebhook } from './routes/meta';
import { dashboardPage, metricsSummary } from './routes/dashboard';
import { callsPage, callsData } from './routes/calls';
import { initDb, dbRecentAudit, dbEnabled, startRetentionSweep } from './store/db';
import { snapshot } from './obs/metrics';
import { kvKind } from './store/kv';
import { requireDashboardToken, requireAdminToken, requireAllowedOrigin } from './routes/guard';
import { verifyBitrixEvent } from './bitrix/verifyEvent';
import { rateLimit } from './routes/rateLimit';

const app = express();
app.set('trust proxy', 1); // detrás del proxy de Railway → req.ip refleja X-Forwarded-For
// Bitrix envía eventos como x-www-form-urlencoded con claves anidadas (data[PARAMS][...]).
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
// Captura el body crudo (verify) además de parsearlo: lo necesita verifyMetaSignature (M4) para
// recalcular el HMAC exactamente sobre los bytes que Meta firmó.
app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { (req as unknown as { rawBody?: Buffer }).rawBody = buf; } }));

// Correlación: asigna un requestId por petición y lo propaga (AsyncLocalStorage) a todos los logs.
app.use((req, res, next) => {
  const requestId = req.header('x-request-id') || crypto.randomUUID();
  res.setHeader('x-request-id', requestId);
  runWithRequestContext({ requestId }, () => next());
});

// DIAGNÓSTICO: registra TODA petición entrante (método + ruta + evento si lo trae).
app.use((req, _res, next) => {
  const event = (req.body as any)?.event;
  log.info(`REQ ${req.method} ${req.path}${event ? ` event=${event}` : ''}`);
  next();
});

// Rate limiting en memoria (por IP): global + estricto para endpoints costosos (eventos, llamadas).
const RL_WINDOW = 60_000;
const globalLimiter = rateLimit({ name: 'global', windowMs: RL_WINDOW, max: Number(process.env.RATE_LIMIT_MAX ?? 600) });
const strictLimiter = rateLimit({ name: 'strict', windowMs: RL_WINDOW, max: Number(process.env.RATE_LIMIT_STRICT ?? 240) });
app.use(globalLimiter);

// Bitrix abre la "Ruta del controlador" (esta URL) por POST al entrar al app → aceptamos ambos.
app.all('/', (_req, res) =>
  res.send(
    `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui,sans-serif;padding:2rem">` +
      `PoC Agente Bitrix24 — funcionando ✅. El bot opera en segundo plano (Open Lines).` +
      `</body>`,
  ),
);
app.get('/health', (_req, res) =>
  res.json({ ok: true, kv: kvKind, persistent: kvKind === 'redis', t: new Date().toISOString() }),
);

// Diagnóstico: confirma qué configuración ve la instancia (sin exponer secretos).
app.get('/debug/config', requireDashboardToken, (_req, res) =>
  res.json({
    baseUrl: config.baseUrl || '(vacío)',
    eventHandler: config.baseUrl ? `${config.baseUrl}/events/bot/message` : '(BASE_URL vacío)',
    model: config.model,
    botCode: config.botCode,
    hasAnthropicKey: Boolean(config.anthropicApiKey),
    hasClientId: Boolean(config.bitrixClientId),
    hasClientSecret: Boolean(config.bitrixClientSecret),
    hasWebhook: Boolean(config.bitrixWebhookUrl),
    uf: {
      score: config.ufScore || '(vacío)',
      intent: config.ufIntent || '(vacío)',
      sentiment: config.ufSentiment || '(vacío)',
      programa: config.ufPrograma || '(vacío)',
    },
    voz: {
      vapiApiKey: Boolean(config.vapiApiKey),
      vapiAssistantId: Boolean(config.vapiAssistantId),
      vapiPhoneNumberId: Boolean(config.vapiPhoneNumberId),
      vapiSecret: Boolean(config.vapiSecret),
      telephonyUserId: config.voiceUserId || '(vacío)',
      transferFallback: Boolean(config.voiceTransferFallback),
    },
  }),
);

// CSS/JS de los paneles (public/dashboard, public/calls): sin datos de negocio, no requieren token
// (el token protege las páginas y las APIs de datos, no estos assets estáticos — ver ALT-Baja-7).
app.use('/assets/dashboard', express.static(fileURLToPath(new URL('../public/dashboard', import.meta.url))));
app.use('/assets/calls', express.static(fileURLToPath(new URL('../public/calls', import.meta.url))));

// Panel de métricas embebible en Bitrix24 (placement) + su API de datos.
app.all('/app', requireDashboardToken, dashboardPage); // Bitrix abre la página del placement (GET/POST con auth)
app.get('/metrics/summary', requireDashboardToken, metricsSummary);

// Módulo de analítica de llamadas (telefonía Bitrix24): página embebible + su API de datos.
app.all('/calls', requireDashboardToken, callsPage);
app.get('/calls/data', requireDashboardToken, callsData);

// Observabilidad: métricas (JSON) y panel de estadísticas (HTML).
app.get('/metrics', requireDashboardToken, async (_req, res) => {
  const s = await snapshot();
  res.json({ ...s, kv: kvKind, db: dbEnabled() ? 'postgres' : 'off' });
});
app.get('/stats', requireDashboardToken, async (_req, res) => {
  const m = await snapshot();
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

// Eventos del bot de Open Lines (rate-limit estricto + verificación del application_token de Bitrix).
app.post('/events/bot/message', strictLimiter, verifyBitrixEvent, botMessageHandler);
app.post('/events/bot/welcome', strictLimiter, verifyBitrixEvent, botWelcomeHandler);
app.post('/events/bot/delete', strictLimiter, verifyBitrixEvent, botDeleteHandler);

// Utilidades de setup manual (protegidas con ADMIN_TOKEN).
app.use('/setup', requireAdminToken);
app.get('/setup/register-bot', registerBotManual);
app.get('/setup/unregister-bot', unregisterBotManual);
app.get('/setup/deal-stages', listDealStages);
app.get('/setup/deal-responsable', dealResponsable);
app.get('/setup/bind-dashboard', bindDashboardManual);
app.get('/setup/bind-calls', bindCallsManual);
app.get('/setup/sync-calls', syncCallsManual);

// Fase 2: agente de voz con Vapi
app.post('/vapi/events', verifyVapiSecret, vapiEvents); // webhook de Vapi (tool-calls, end-of-call-report)
app.post('/voice/outbound', strictLimiter, verifyVapiSecret, voiceOutbound); // dispara una llamada saliente con Vapi
// M2: modo Custom LLM (Vapi hace STT/TTS y delega el "cerebro" a nuestro motor, con el perfil de voz).
// Vapi llama a {model.url}/chat/completions; aceptamos también /vapi/llm por conveniencia.
app.post('/vapi/llm/chat/completions', strictLimiter, verifyVapiSecret, vapiChatCompletions);
app.post('/vapi/llm', strictLimiter, verifyVapiSecret, vapiChatCompletions);

// M3: canal Web Chat — widget embebible + su API. Público (chat de sitio) con rate-limit estricto por IP.
app.get('/webchat', webchatPage);
app.post('/webchat/message', strictLimiter, requireAllowedOrigin, webchatMessage);

// M4: canales Instagram/Messenger (Meta Graph API). GET = handshake de verificación (sin rate-limit,
// Meta lo llama una sola vez al suscribir). POST = webhook de mensajes, con verificación de firma.
app.get('/webhooks/meta', metaVerify);
app.post('/webhooks/meta', strictLimiter, verifyMetaSignature, metaWebhook);

// Inicializa Postgres (auditoría + espejo de llamadas) y arranca el scheduler de sync de llamadas.
initDb()
  .then(() => {
    startCallSync();
    startRetentionSweep();
  })
  .catch((e) => log.error('initDb error', { err: String(e) }));

app.listen(config.port, () =>
  log.info('PoC escuchando', { port: config.port, baseUrl: config.baseUrl || '(define BASE_URL)' }),
);
