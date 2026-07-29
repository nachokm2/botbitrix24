import { config } from '../src/config';

// Activa el "backchanneling": Sofía intercala pequeños "ajá / ya / claro" mientras el usuario habla,
// para que la conversación se sienta más viva y humana (no acorta la latencia, mejora la percepción).
// Uso: railway run -- npx tsx scripts/vapi-set-backchannel.ts [true|false]
async function main() {
  if (!config.vapiApiKey || !config.vapiAssistantId) {
    throw new Error('Faltan VAPI_API_KEY / VAPI_ASSISTANT_ID en el entorno.');
  }
  const enabled = (process.argv[2] ?? 'true') !== 'false';
  const r = await fetch(`https://api.vapi.ai/assistant/${config.vapiAssistantId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${config.vapiApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ backchannelingEnabled: enabled }),
  });
  const json: any = await r.json();
  if (!r.ok) {
    console.error('❌ Vapi respondió', r.status, JSON.stringify(json));
    process.exit(1);
  }
  console.log('✅ backchannelingEnabled =', json?.backchannelingEnabled);
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
