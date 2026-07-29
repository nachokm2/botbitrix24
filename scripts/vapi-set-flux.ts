import { config } from '../src/config';

// Activa/revierte Deepgram Flux (STT con detección de turno NATIVA → recorta la pausa entre turnos).
// Flux exige cambiar el transcriber a su modelo (flux-general-multi, multilingüe) + smartEndpointingPlan=deepgram-flux.
//   flux   (def.): transcriber Deepgram Flux + endpointing deepgram-flux
//   revert       : vuelve a Deepgram nova-2 (es) + endpointing livekit
// Uso: railway run -- npx tsx scripts/vapi-set-flux.ts [flux|revert]
async function main() {
  if (!config.vapiApiKey || !config.vapiAssistantId) {
    throw new Error('Faltan VAPI_API_KEY / VAPI_ASSISTANT_ID en el entorno.');
  }
  const mode = process.argv[2] || 'flux';
  const body =
    mode === 'revert'
      ? {
          transcriber: { provider: 'deepgram', model: 'nova-2', language: 'es' },
          startSpeakingPlan: { waitSeconds: 0.2, smartEndpointingPlan: { provider: 'livekit' } },
        }
      : {
          // Flux se activa a nivel de TRANSCRIBER (trae detección de turno nativa). El smartEndpointingPlan
          // solo acepta vapi|livekit|custom-endpointing-model, así que dejamos livekit como respaldo.
          transcriber: { provider: 'deepgram', model: 'flux-general-multi' },
          startSpeakingPlan: { waitSeconds: 0.2, smartEndpointingPlan: { provider: 'livekit' } },
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
  console.log('✅ Aplicado modo:', mode);
  console.log('transcriber:', JSON.stringify(json?.transcriber ?? {}));
  console.log('startSpeakingPlan:', JSON.stringify(json?.startSpeakingPlan ?? {}));
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
