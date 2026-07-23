import { config } from '../src/config';

// Migración M2: cambia el asistente de Vapi de modo NATIVO (Anthropic + knowledgeBase propia de Vapi)
// a modo CUSTOM LLM (Vapi hace solo STT/TTS/turn-taking; el "cerebro" pasa a ser nuestro backend,
// vía runConversation con el prompt "Sofía" replicado en core/channel.ts). Solo reemplaza el campo
// `model`; deja intactos voice/transcriber/server/firstMessage/etc. del asistente ya afinado.
// Uso: railway run -- npx tsx scripts/vapi-set-custom-llm.ts
async function main() {
  if (!config.vapiApiKey || !config.vapiAssistantId) {
    throw new Error('Faltan VAPI_API_KEY / VAPI_ASSISTANT_ID en el entorno.');
  }
  if (!config.baseUrl) {
    throw new Error('Falta BASE_URL en el entorno.');
  }
  if (!config.vapiSecret) {
    throw new Error('Falta VAPI_SECRET en el entorno (lo necesita /vapi/llm para autenticar a Vapi).');
  }

  const body = {
    model: {
      provider: 'custom-llm',
      url: `${config.baseUrl}/vapi/llm`,
      model: 'ua-postgrados-voz',
      temperature: 0.4,
      maxTokens: 400,
      headers: { 'x-vapi-secret': config.vapiSecret },
    },
  };

  const r = await fetch(`https://api.vapi.ai/assistant/${config.vapiAssistantId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${config.vapiApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await r.json();
  if (!r.ok) {
    console.error('❌ Vapi respondió', r.status, JSON.stringify(json));
    process.exit(1);
  }
  console.log('✅ Asistente actualizado a Custom LLM');
  console.log('model.provider:', json.model?.provider);
  console.log('model.url:', json.model?.url);
  console.log('model.model:', json.model?.model);
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
