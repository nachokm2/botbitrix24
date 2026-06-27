import Anthropic from '@anthropic-ai/sdk';
import { config } from '../src/config';

// F1-T4: valida la API de Anthropic (Sonnet 4.6) y mide latencia.
async function main() {
  if (!config.anthropicApiKey) throw new Error('Falta ANTHROPIC_API_KEY en .env');

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const t0 = Date.now();
  const r = await client.messages.create({
    model: config.model,
    max_tokens: 200,
    messages: [{ role: 'user', content: 'En una sola frase, ¿qué es un MBA?' }],
  });
  const ms = Date.now() - t0;

  const text = r.content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('\n');

  console.log(`✅ modelo=${config.model}  latencia=${ms}ms`);
  console.log('respuesta:', text);
  console.log('tokens:', r.usage);
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
