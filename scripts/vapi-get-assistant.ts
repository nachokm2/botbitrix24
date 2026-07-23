import { config } from '../src/config';

// Lectura de diagnóstico: trae la config ACTUAL del asistente de Vapi antes de tocarla
// (para saber qué preservar al pasar a Custom LLM). No imprime API keys ni secretos propios.
async function main() {
  if (!config.vapiApiKey || !config.vapiAssistantId) {
    throw new Error('Faltan VAPI_API_KEY / VAPI_ASSISTANT_ID en el entorno.');
  }
  const r = await fetch(`https://api.vapi.ai/assistant/${config.vapiAssistantId}`, {
    headers: { Authorization: `Bearer ${config.vapiApiKey}` },
  });
  const json = await r.json();
  if (!r.ok) {
    console.error('❌ Vapi respondió', r.status, JSON.stringify(json));
    process.exit(1);
  }
  console.log(JSON.stringify(json, null, 2));
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
