import { config } from '../src/config';

// Configura las frases de cierre que, al decirlas Sofía, TERMINAN la llamada (endCallPhrases de Vapi).
// Se combina con el prompt: cuando el cliente se despide, Sofía cierra con "Que tenga un excelente día."
// y Vapi cuelga (ended reason: assistant-said-end-call-phrase). Son frases que solo se usan al final,
// para evitar cortes accidentales a mitad de conversación.
// Uso: railway run -- npx tsx scripts/vapi-set-endcall.ts
async function main() {
  if (!config.vapiApiKey || !config.vapiAssistantId) {
    throw new Error('Faltan VAPI_API_KEY / VAPI_ASSISTANT_ID en el entorno.');
  }
  const body = {
    endCallPhrases: [
      'que tenga un excelente día',
      'que tenga un buen día',
      'que tenga una buena tarde',
      'que tenga una buena noche',
      'que esté muy bien',
      'hasta luego',
    ],
  };
  const r = await fetch(`https://api.vapi.ai/assistant/${config.vapiAssistantId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${config.vapiApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json: any = await r.json();
  if (!r.ok) {
    console.error('❌ Vapi respondió', r.status, JSON.stringify(json));
    process.exit(1);
  }
  console.log('✅ endCallPhrases:', JSON.stringify(json?.endCallPhrases ?? []));
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
