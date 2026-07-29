import { config } from '../src/config';

// Activa/revierte Deepgram Flux (STT con detección de turno NATIVA → recorta la pausa entre turnos).
// Flux exige cambiar el transcriber a su modelo (flux-general-multi, multilingüe) + smartEndpointingPlan=deepgram-flux.
//   flux   (def.): transcriber Deepgram Flux (flux-general-multi) — detección de turno nativa
//   nova3        : transcriber Deepgram nova-3 (es) + endpointing livekit (texto)
//   nova2/revert : transcriber Deepgram nova-2 (es) + endpointing livekit (texto)
// Uso: railway run -- npx tsx scripts/vapi-set-flux.ts [flux|nova3|nova2|revert]
async function main() {
  if (!config.vapiApiKey || !config.vapiAssistantId) {
    throw new Error('Faltan VAPI_API_KEY / VAPI_ASSISTANT_ID en el entorno.');
  }
  const mode = process.argv[2] || 'flux';
  // Flux trae detección de turno NATIVA a nivel de transcriber. nova-2/nova-3 usan endpointing por texto
  // (smartEndpointingPlan solo acepta vapi|livekit|custom-endpointing-model). Todos con livekit de respaldo.
  const transcriber =
    mode === 'revert' || mode === 'nova2'
      ? { provider: 'deepgram', model: 'nova-2', language: 'es' }
      : mode === 'nova3'
        ? { provider: 'deepgram', model: 'nova-3', language: 'es' }
        : { provider: 'deepgram', model: 'flux-general-multi' };
  const body = {
    transcriber,
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
