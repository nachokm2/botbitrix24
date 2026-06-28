import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';

export const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

export const REASONER = config.model; // claude-sonnet-4-6
export const CLASSIFIER = config.classifierModel; // claude-haiku-4-5
