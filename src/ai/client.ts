import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';

export const anthropic = new Anthropic({
  apiKey: config.anthropicApiKey,
  timeout: Number(process.env.ANTHROPIC_TIMEOUT_MS ?? 45_000), // un turno de chat no debe colgar ~10 min
  maxRetries: Number(process.env.ANTHROPIC_MAX_RETRIES ?? 2),
});

export const REASONER = config.model; // claude-sonnet-4-6
export const CLASSIFIER = config.classifierModel; // claude-haiku-4-5
