import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT ?? 3000),
  /** URL pública del app (Railway o túnel), sin slash final. */
  baseUrl: (process.env.BASE_URL ?? '').replace(/\/$/, ''),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
  classifierModel: process.env.ANTHROPIC_CLASSIFIER ?? 'claude-haiku-4-5',
  bitrixWebhookUrl: (process.env.BITRIX_WEBHOOK_URL ?? '').replace(/\/$/, ''),
  botCode: process.env.BOT_CODE ?? 'poc_agente_postgrados',
  // OAuth de la app local (para renovar el access_token cuando expira).
  bitrixClientId: process.env.BITRIX_CLIENT_ID ?? '',
  bitrixClientSecret: process.env.BITRIX_CLIENT_SECRET ?? '',
  // Fallback de BOT_ID (el storage de Railway es efímero entre deploys).
  botId: process.env.BITRIX_BOT_ID ? Number(process.env.BITRIX_BOT_ID) : undefined,
  // Persistencia (opcionales; si faltan, se usa memoria/no-op).
  redisUrl: process.env.REDIS_URL ?? '',
  databaseUrl: process.env.DATABASE_URL ?? '',
  pgSsl: process.env.PGSSL === 'true',
};
