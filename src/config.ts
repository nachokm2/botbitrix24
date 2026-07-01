import 'dotenv/config';

// Mapa de etapas por embudo para el movimiento por score, ej:
// {"1":{"alto":"C1:PREPARATION","medio":"C1:UC_JARL1O"},"3":{"alto":"C3:PREPAYMENT_INVOICE","medio":"C3:PREPARATION"}}
function parseStageMap(s?: string): Record<string, { alto?: string; medio?: string }> {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

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
  // Códigos de campos personalizados (UF) opcionales para guardar el scoring en el CRM (en el Deal/Negociación).
  ufScore: process.env.BITRIX_UF_SCORE ?? '',
  ufIntent: process.env.BITRIX_UF_INTENT ?? '',
  ufSentiment: process.env.BITRIX_UF_SENTIMENT ?? '',
  // Campo UF (en el Deal) para el "Programa de interés" que el bot actualiza según la conversación.
  ufPrograma: process.env.BITRIX_UF_PROGRAMA ?? '',
  // Mover la etapa del deal según el score. Mapa por embudo (recomendado, multi-flujo):
  stageMap: parseStageMap(process.env.BITRIX_STAGE_MAP),
  // Fallback de un solo embudo (legacy):
  stageScoreAlto: process.env.BITRIX_STAGE_SCORE_ALTO ?? '', // score >= 70
  stageScoreMedio: process.env.BITRIX_STAGE_SCORE_MEDIO ?? '', // score 40-69
  // Auto-escalar a humano si el score alcanza este umbral (0 = desactivado).
  scoreEscalar: Number(process.env.SCORE_ESCALAR ?? 80),

  // ── Fase 2: Agente de voz (Voximplant VoxEngine + telefonía Bitrix) ──
  // Usuario Bitrix "dueño" de las llamadas del bot (para telephony.externalCall.*).
  voiceUserId: Number(process.env.BITRIX_TELEPHONY_USER_ID ?? 0),
  // Número de línea externa (para vinculación/analítica en Bitrix).
  voiceLineNumber: process.env.BITRIX_TELEPHONY_LINE ?? '',
  // Modelo de Claude para la voz (Haiku por latencia; "equilibrado").
  voiceModel: process.env.VOICE_MODEL ?? process.env.ANTHROPIC_CLASSIFIER ?? 'claude-haiku-4-5',
  // Destino de derivación a humano cuando no hay asesor asignado (número PSTN o SIP URI).
  voiceTransferFallback: process.env.VOICE_TRANSFER_FALLBACK ?? '',
  // Secreto compartido que el escenario VoxEngine envía en cada request (valida el origen).
  voiceSharedSecret: process.env.VOICE_SHARED_SECRET ?? '',
};
