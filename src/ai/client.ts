import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';

// Único punto de acoplamiento a Anthropic como proveedor de LLM (ver ALT-Baja-8 de la auditoría).
// `agentLoop.ts`, `scoring.ts` y `briefing.ts` llaman a `anthropic.messages.create(...)` directamente
// y consumen la forma nativa del SDK (bloques `text`/`tool_use`, `system` como parámetro aparte,
// esquema de tools de Anthropic) — no hay una capa de abstracción intermedia. Migrar a otro proveedor
// hoy implicaría tocar esos 3 call sites (no solo este archivo): normalizar la forma de la respuesta,
// el formato del system prompt y el esquema de tool-calling. No urge — se documenta como referencia
// para si algún día se evalúa multi-modelo.
export const anthropic = new Anthropic({
  apiKey: config.anthropicApiKey,
  timeout: Number(process.env.ANTHROPIC_TIMEOUT_MS ?? 45_000), // un turno de chat no debe colgar ~10 min
  maxRetries: Number(process.env.ANTHROPIC_MAX_RETRIES ?? 2),
});

export const REASONER = config.model; // claude-sonnet-4-6
export const CLASSIFIER = config.classifierModel; // claude-haiku-4-5
