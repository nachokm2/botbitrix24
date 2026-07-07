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

// Mapa simple embudo→etapa (un solo STAGE_ID por embudo), ej: {"1":"C1:UC_ABC","3":"C3:UC_XYZ"}
function parseSimpleStageMap(s?: string): Record<string, string> {
  if (!s) return {};
  try {
    const p = JSON.parse(s);
    return p && typeof p === 'object' ? p : {};
  } catch {
    return {};
  }
}

// Etiquetas de embudo por CATEGORY_ID. Default: 0=General, 1=Diplomados, 3=Magísteres.
function parseFunnelLabels(s?: string): Record<string, string> {
  const def = { '0': 'General', '1': 'Diplomados', '3': 'Magísteres' };
  if (!s) return def;
  try {
    const p = JSON.parse(s);
    return p && typeof p === 'object' && Object.keys(p).length ? p : def;
  } catch {
    return def;
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
  // Etiquetas legibles por CATEGORY_ID de embudo, para el panel (C1=Diplomados, C3=Magísteres).
  funnelLabels: parseFunnelLabels(process.env.BITRIX_FUNNEL_LABELS),
  // Fallback de un solo embudo (legacy):
  stageScoreAlto: process.env.BITRIX_STAGE_SCORE_ALTO ?? '', // score >= 70
  stageScoreMedio: process.env.BITRIX_STAGE_SCORE_MEDIO ?? '', // score 40-69
  // Auto-escalar a humano si el score alcanza este umbral (0 = desactivado).
  scoreEscalar: Number(process.env.SCORE_ESCALAR ?? 80),
  // Auto-LLAMAR por voz (Vapi) si el score alcanza este umbral (0 = desactivado). Ej: 50.
  scoreLlamar: Number(process.env.SCORE_LLAMAR ?? 0),
  // Precio Anthropic por millón de tokens (USD) para estimar costo en el panel (0 = no mostrar).
  costInPerMtok: Number(process.env.ANTHROPIC_COST_IN_PER_MTOK ?? 0),
  costOutPerMtok: Number(process.env.ANTHROPIC_COST_OUT_PER_MTOK ?? 0),

  // ── Fase 2: Agente de voz (Vapi + Twilio + registro en telefonía Bitrix) ──
  // Vapi corre la conversación (STT/TTS/barge-in + Claude) y llama a nuestro backend por webhooks.
  vapiApiKey: process.env.VAPI_API_KEY ?? '', // API key privada de Vapi (para outbound / setup)
  vapiAssistantId: process.env.VAPI_ASSISTANT_ID ?? '',
  vapiPhoneNumberId: process.env.VAPI_PHONE_NUMBER_ID ?? '', // número (BYO Twilio) importado a Vapi
  vapiSecret: process.env.VAPI_SECRET ?? '', // server.secret: Vapi lo envía en header x-vapi-secret
  // Registro de la llamada en el CRM de Bitrix (telephony.externalCall.*):
  voiceUserId: Number(process.env.BITRIX_TELEPHONY_USER_ID ?? 0), // usuario Bitrix "dueño" de las llamadas
  voiceLineNumber: process.env.BITRIX_TELEPHONY_LINE ?? '', // nº de línea externa (opcional)
  // Destino de derivación a humano cuando no hay asesor asignado (número PSTN o SIP URI).
  voiceTransferFallback: process.env.VOICE_TRANSFER_FALLBACK ?? '',

  // ── Acciones de "lead caliente" cuando el agente de voz capta interés en un programa ──
  // Etapa a la que mover el Deal, por embudo: {"1":"C1:UC_XXX","3":"C3:UC_YYY"}.
  // Si no está, cae a config.stageMap[cat].alto (el mismo de scoring alto).
  voiceStageMap: parseSimpleStageMap(process.env.VOICE_STAGE_MAP),
  voiceStageInteresado: process.env.VOICE_STAGE_INTERESADO ?? '', // fallback de un solo embudo
  // Minutos de plazo (DEADLINE) de la tarea al asesor. Default 15.
  voiceTaskMinutes: Number(process.env.VOICE_TASK_MINUTES ?? 15),
  // Asesor por defecto para la tarea si el Deal no tiene responsable (o es un lead nuevo). 0 = no crear.
  voiceTaskUserId: Number(process.env.VOICE_TASK_FALLBACK_USER ?? 0),
};
