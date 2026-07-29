import { config } from '../src/config';

// Reduce la latencia percibida: menor espera antes de responder + smart endpointing (detecta mejor
// cuándo el usuario terminó de hablar). NO toca el barge-in (stopSpeakingPlan) para no romper las
// interrupciones ya afinadas. Uso: railway run -- npx tsx scripts/vapi-set-turntaking.ts [waitSeconds]
async function main() {
  if (!config.vapiApiKey || !config.vapiAssistantId) {
    throw new Error('Faltan VAPI_API_KEY / VAPI_ASSISTANT_ID en el entorno.');
  }
  const waitSeconds = Number(process.argv[2] ?? 0.4);
  const body = {
    startSpeakingPlan: {
      waitSeconds, // cuánto espera tras el silencio antes de responder (menor = más ágil)
      smartEndpointingPlan: { provider: 'livekit' }, // detección inteligente de fin de turno (baja latencia)
    },
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
  console.log('✅ Turn-taking actualizado');
  console.log('startSpeakingPlan:', JSON.stringify(json?.startSpeakingPlan ?? {}, null, 2));
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
