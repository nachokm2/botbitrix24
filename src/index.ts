import express from 'express';
import crypto from 'crypto';
import { fileURLToPath } from 'node:url';
import { config } from './config';
import { marca } from './marca';
import { log } from './log';
import { runWithRequestContext } from './obs/requestContext';
import { installHandler, oauthCodeOrNext } from './routes/install';
import { botMessageHandler, botWelcomeHandler, botDeleteHandler } from './routes/botEvents';
import { registerBotManual, unregisterBotManual, updateBotManual, triggerBrochureManual, listDealFields, listDealStages, dealResponsable, bindDashboardManual, bindCallsManual, bindPanelManual, syncCallsManual, placementInfo, dialogosListar, dialogosBorrar, chatappPlantillas, chatappPrueba, primerContactoResultado, calidadDatos, moverDerivados } from './routes/setup';
import { startCallSync } from './crm/callSync';
import { vapiEvents, voiceOutbound, verifyVapiSecret, whatsappInboundCall } from './routes/vapi';
import { vapiChatCompletions } from './routes/vapiLlm';
import { webchatMessage, webchatPage } from './routes/webchat';
import { metaVerify, verifyMetaSignature, metaWebhook } from './routes/meta';
import { dashboardPage, metricsSummary, conversacionDetalle } from './routes/dashboard';
import { callsPage, callsData } from './routes/calls';
import { initDb, dbRecentAudit, dbEnabled, dbHealth, startRetentionSweep, dbConfigPublicadas } from './store/db';
import { iniciarRevisionDiaria } from './ai/revisionDiaria';
import { iniciarResumenSemanal } from './ai/resumenSemanal';
import { iniciarVigilanciaCanal } from './ai/vigilanciaCanal';
import { iniciarVigilanciaSalud } from './bitrix/salud';
import { iniciarPrimerContacto } from './crm/primerContacto';
import { iniciarReactivacion } from './crm/reactivacion';
import { iniciarBarridoSeguimientos } from './ai/seguimiento';
import { snapshot } from './obs/metrics';
import { kvKind, redisHealth } from './store/kv';
import { requireDashboardToken, requireAdminToken, requireAllowedOrigin } from './routes/guard';
import { startCampaignScheduler } from './campaign/scheduler';
import { campaignEnroll, campaignStatus, campaignData, campaignDashboard } from './routes/campaign';
import { verifyBitrixEvent } from './bitrix/verifyEvent';
import { rateLimit } from './routes/rateLimit';
import { manejarAsync, manejadorDeErrores } from './routes/errores';
import { paginaStats } from './routes/stats';
import { panelPagina, panelLeerSeccion, panelGuardarBorrador, panelDescartarBorrador, panelPublicar, panelRestaurar, panelVistaHorarios } from './routes/panelConfig';
import { requirePanelSesion } from './routes/panelSesion';
import { iniciarRefrescoAjustes } from './core/ajustes';

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
// Liveness + estado de dependencias (INF-07). SIEMPRE responde 200: si este handler corre, el proceso
// está vivo y Railway NO debe reiniciarlo (healthcheckPath=/health). El estado de Postgres/Redis va en
// el cuerpo —`postgres`/`redis` ('up'|'down'|'off') y `degraded`— para que una caída de dependencia se
// NOTE y se pueda alertar, en vez de seguir diciendo "ok" en silencio (el incidente del 2026-10-23
// tuvo /health "ok" con Postgres caído una hora).
app.get('/health', async (_req, res) => {
  let postgres: 'up' | 'down' | 'off' = 'off';
  try {
    postgres = await dbHealth();
  } catch {
    postgres = 'down';
  }
  const redis = redisHealth();
  const degraded = postgres === 'down' || redis === 'down';
  res.json({
    ok: true,
    degraded,
    postgres,
    redis,
    kv: kvKind,
    persistent: kvKind === 'redis',
    t: new Date().toISOString(),
  });
});

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
// Imágenes del correo institucional del brochure (campus, sello CNA), servidas para los <img> del email.
app.use('/assets/email', express.static(fileURLToPath(new URL('../public/email', import.meta.url))));
app.use('/assets/panel', express.static(fileURLToPath(new URL('../public/panel', import.meta.url))));

// Panel de configuración del bot (core/ajustes.ts): se entra con el usuario de Bitrix24 y solo si está
// en PANEL_EDITORES; sin editores, todo /panel responde 404.
app.all('/panel', manejarAsync(panelPagina));
app.use('/panel/api', requirePanelSesion);
app.get('/panel/api/seccion/:seccion', manejarAsync(panelLeerSeccion));
app.put('/panel/api/seccion/:seccion/borrador', manejarAsync(panelGuardarBorrador));
app.delete('/panel/api/seccion/:seccion/borrador/:id', manejarAsync(panelDescartarBorrador));
app.post('/panel/api/seccion/:seccion/publicar', manejarAsync(panelPublicar));
app.post('/panel/api/seccion/:seccion/restaurar', manejarAsync(panelRestaurar));
app.post('/panel/api/seccion/horarios/vista', manejarAsync(panelVistaHorarios));

// Panel de métricas embebible en Bitrix24 (placement) + su API de datos.
// Los handlers async van envueltos en manejarAsync: Express 4 no captura su rechazo y Node terminaría
// el proceso (ver routes/errores.ts).
app.all('/app', manejarAsync(oauthCodeOrNext), requireDashboardToken, dashboardPage); // Bitrix abre la página del placement (GET/POST con auth); con ?code= completa la instalación
app.get('/metrics/summary', requireDashboardToken, manejarAsync(metricsSummary));
app.get('/metrics/conversacion', requireDashboardToken, manejarAsync(conversacionDetalle)); // intercambio completo de UN diálogo

// Módulo de analítica de llamadas (telefonía Bitrix24): página embebible + su API de datos.
app.all('/calls', requireDashboardToken, callsPage);
app.get('/calls/data', requireDashboardToken, manejarAsync(callsData));

// Observabilidad: métricas (JSON) y panel de estadísticas (HTML).
app.get('/metrics', requireDashboardToken, manejarAsync(async (_req, res) => {
  const s = await snapshot();
  res.json({ ...s, kv: kvKind, db: dbEnabled() ? 'postgres' : 'off' });
}));
app.get('/stats', requireDashboardToken, manejarAsync(async (_req, res) => {
  const m = await snapshot();
  const audits = await dbRecentAudit(25);
  res.send(paginaStats(m, audits, kvKind, dbEnabled())); // escapa todo: ver routes/stats.ts
}));

// Instalación del app local (registra el bot)
app.all('/install', manejarAsync(installHandler));

// Eventos del bot de Open Lines (rate-limit estricto + verificación del application_token de Bitrix).
app.post('/events/bot/message', strictLimiter, verifyBitrixEvent, manejarAsync(botMessageHandler));
app.post('/events/bot/welcome', strictLimiter, verifyBitrixEvent, botWelcomeHandler);
app.post('/events/bot/delete', strictLimiter, verifyBitrixEvent, botDeleteHandler);

// Utilidades de setup manual (protegidas con ADMIN_TOKEN).
app.use('/setup', requireAdminToken);
app.get('/setup/register-bot', manejarAsync(registerBotManual));
app.get('/setup/update-bot', manejarAsync(updateBotManual));
app.get('/setup/test-brochure', manejarAsync(triggerBrochureManual));
app.get('/setup/unregister-bot', manejarAsync(unregisterBotManual));
app.get('/setup/deal-stages', manejarAsync(listDealStages));
app.get('/setup/deal-fields', manejarAsync(listDealFields));
app.get('/setup/deal-responsable', manejarAsync(dealResponsable));
app.get('/setup/bind-dashboard', manejarAsync(bindDashboardManual));
app.get('/setup/placement-info', manejarAsync(placementInfo));
app.get('/setup/dialogos', manejarAsync(dialogosListar)); // lista los diálogos registrados
app.get('/setup/dialogos/borrar', manejarAsync(dialogosBorrar)); // borra los indicados (irreversible) // diagnóstico: qué ve Bitrix de esta app
app.get('/setup/chatapp-plantillas', manejarAsync(chatappPlantillas)); // qué plantillas hay y con qué UUID
app.get('/setup/chatapp-prueba', manejarAsync(chatappPrueba)); // envío de prueba a UN número, antes de encender
app.get('/setup/primer-contacto-resultado', manejarAsync(primerContactoResultado)); // cuántos contestaron, por plantilla
app.get('/setup/calidad-datos', manejarAsync(calidadDatos));
app.get('/setup/mover-derivados', manejarAsync(moverDerivados)); // simula por defecto; ?ejecutar=1 escribe // teléfonos y fichas defectuosas, que ahora cuestan dinero
app.get('/setup/bind-calls', manejarAsync(bindCallsManual));
app.get('/setup/bind-panel', manejarAsync(bindPanelManual)); // pestaña "Configuración bot" dentro de Bitrix24
app.get('/setup/sync-calls', manejarAsync(syncCallsManual));

// Campaña de voz saliente. Panel y datos con DASHBOARD_TOKEN (embebible en Bitrix); acciones
// administrativas (enrolar) con ADMIN_TOKEN. Las rutas del panel se registran ANTES del guard admin.
app.all('/campaign/dashboard', requireDashboardToken, campaignDashboard);
app.get('/campaign/data', requireDashboardToken, manejarAsync(campaignData));
app.use('/campaign', requireAdminToken);
app.post('/campaign/enroll', manejarAsync(campaignEnroll));
app.get('/campaign/status', manejarAsync(campaignStatus));

// Canales ADEMÁS de WhatsApp: solo se registran si la marca los expone (ver marca.ts). Una marca de
// un solo canal, como Carver, no debe tener vivos estos endpoints: son superficie pública sin uso y
// responden con la identidad de Postgrados, porque sus prompts no están parametrizados por marca.
if (marca.tieneVoz) {
  // Fase 2: agente de voz con Vapi
  app.post('/vapi/events', verifyVapiSecret, manejarAsync(vapiEvents)); // webhook de Vapi (tool-calls, end-of-call-report)
  app.post('/voice/outbound', strictLimiter, verifyVapiSecret, manejarAsync(voiceOutbound)); // dispara una llamada saliente con Vapi
// Callback de WhatsApp Calling: el SBC Asterisk detecta la entrante y golpea este endpoint (GET/POST con
// ?secret=&from=) para que Sofía DEVUELVA la llamada por el trunk de WhatsApp (la entrante directa no se
// puede atender por un límite de media de Vapi). Auth propia por secreto dedicado dentro del handler.
  app.get('/whatsapp/inbound-call', strictLimiter, manejarAsync(whatsappInboundCall));
  app.post('/whatsapp/inbound-call', strictLimiter, manejarAsync(whatsappInboundCall));
// M2: modo Custom LLM (Vapi hace STT/TTS y delega el "cerebro" a nuestro motor, con el perfil de voz).
// Vapi llama a {model.url}/chat/completions; aceptamos también /vapi/llm por conveniencia.
  app.post('/vapi/llm/chat/completions', strictLimiter, verifyVapiSecret, manejarAsync(vapiChatCompletions));
  app.post('/vapi/llm', strictLimiter, verifyVapiSecret, manejarAsync(vapiChatCompletions));
}

if (marca.otrosCanales) {
  // M3: canal Web Chat — widget embebible + su API. Público (chat de sitio) con rate-limit estricto por IP.
  app.get('/webchat', webchatPage);
  app.post('/webchat/message', strictLimiter, requireAllowedOrigin, manejarAsync(webchatMessage));

  // M4: canales Instagram/Messenger (Meta Graph API). GET = handshake de verificación (sin rate-limit,
  // Meta lo llama una sola vez al suscribir). POST = webhook de mensajes, con verificación de firma.
  app.get('/webhooks/meta', metaVerify);
  app.post('/webhooks/meta', strictLimiter, verifyMetaSignature, manejarAsync(metaWebhook));
}

// Errores de cualquier ruta, incluido el rechazo de un handler async: se registran y se responde 500.
app.use(manejadorDeErrores);

// Inicializa Postgres (auditoría + espejo de llamadas). Las tareas que necesitan el pool YA al armarse
// (sync de llamadas y retención, que hacen return si !pool) se arrancan desde onReady: así se arman
// cuando Postgres queda listo, sea en el arranque o más tarde si estaba caído y reconectó (INF-05). El
// resto de schedulers comprueban el pool en cada tick, así que se recuperan solos y quedan aquí.
const arrancarTareasConPostgres = () => {
  startCallSync();
  startRetentionSweep();
  iniciarRefrescoAjustes(dbConfigPublicadas); // lo publicado en el panel de configuración; sin nada publicado rige Railway
};
initDb(arrancarTareasConPostgres)
  .then(() => {
    startCampaignScheduler(); // no-op si no hay programas activos (CAMPAIGN_<code>_ACTIVO=true)
    iniciarRevisionDiaria(); // lee las conversaciones del día y deja hallazgos — necesita Postgres
    iniciarResumenSemanal(); // no-op sin RESUMEN_SEMANAL_USUARIOS
    iniciarVigilanciaCanal(); // avisa si deja de entrar conversación (necesita Postgres)
    iniciarVigilanciaSalud(); // avisa si el OAuth o el webhook dejan de funcionar
    iniciarPrimerContacto(); // no-op salvo PRIMER_CONTACTO_ACTIVO=true con plantilla
    iniciarReactivacion(); // no-op salvo REACTIVACION_ACTIVA=true con plantilla
  })
  .catch((e) => log.error('initDb error', { err: String(e) }));

// Seguimiento automático (WhatsApp) — solo Redis, independiente de Postgres.
iniciarBarridoSeguimientos();

app.listen(config.port, () =>
  log.info('PoC escuchando', { port: config.port, baseUrl: config.baseUrl || '(define BASE_URL)' }),
);
