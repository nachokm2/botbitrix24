import { config } from '../src/config';

// Cambia la voz (TTS) del asistente de Vapi a ElevenLabs, con ajustes para sonar MÁS natural
// (menos robótica): estabilidad baja = más expresiva, speaker boost, modelo flash multilingüe (baja latencia).
// Uso: railway run -- npx tsx scripts/vapi-set-voice.ts <VOICE_ID> [modelo]
//   VOICE_ID  → id de la voz ElevenLabs (de scripts/vapi-list-voices.ts) o env VOICE_ID
//   modelo    → eleven_flash_v2_5 (def.) | eleven_turbo_v2_5 | eleven_multilingual_v2
async function main() {
  if (!config.vapiApiKey || !config.vapiAssistantId) {
    throw new Error('Faltan VAPI_API_KEY / VAPI_ASSISTANT_ID en el entorno.');
  }
  const voiceId = process.argv[2] || process.env.VOICE_ID;
  const model = process.argv[3] || 'eleven_flash_v2_5';
  if (!voiceId) throw new Error('Falta el VOICE_ID (arg 1 o env VOICE_ID). Córrelo primero: scripts/vapi-list-voices.ts');

  const body = {
    voice: {
      provider: '11labs',
      voiceId,
      model,
      stability: 0.5, // equilibrio: expresiva pero consistente (evita que suene "rara"/errática)
      similarityBoost: 0.85,
      style: 0.2,
      useSpeakerBoost: true,
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
  console.log('✅ Voz actualizada a ElevenLabs');
  console.log('voice:', JSON.stringify(json?.voice ?? {}, null, 2));
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
