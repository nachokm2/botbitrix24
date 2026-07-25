import { config } from '../src/config';

// Diagnóstico: trae el detalle + transcripción de una llamada Vapi por su ID.
// Uso: railway run -- npx tsx scripts/vapi-get-call.ts <callId>
async function main() {
  const callId = process.argv[2];
  if (!callId) throw new Error('Uso: vapi-get-call.ts <callId>');
  if (!config.vapiApiKey) throw new Error('Falta VAPI_API_KEY en el entorno.');
  const r = await fetch(`https://api.vapi.ai/call/${callId}`, {
    headers: { Authorization: `Bearer ${config.vapiApiKey}` },
  });
  const json: any = await r.json();
  if (!r.ok) {
    console.error('❌ Vapi respondió', r.status, JSON.stringify(json));
    process.exit(1);
  }
  console.log('=== DIAGNÓSTICO ===');
  console.log('status        :', json.status);
  console.log('endedReason   :', json.endedReason);
  console.log('type          :', json.type);
  console.log('startedAt     :', json.startedAt ?? '(no arrancó)');
  console.log('endedAt       :', json.endedAt ?? '—');
  console.log('phoneNumberId :', json.phoneNumberId);
  console.log('customer      :', JSON.stringify(json.customer));
  console.log('cost          :', json.cost ?? '—');
  console.log('metadata      :', JSON.stringify(json.metadata ?? {}));
  if (json.phoneCallProviderDetails) console.log('providerDetails:', JSON.stringify(json.phoneCallProviderDetails));
  if (json.phoneCallProviderId) console.log('providerCallId:', json.phoneCallProviderId);
  console.log('');
  console.log('--- messages (system messages omitidos) ---');
  for (const m of json.messages ?? []) {
    if (m.role === 'system') continue;
    console.log(`[${m.role}] ${m.message ?? m.content ?? JSON.stringify(m)}`);
  }
  console.log('\n--- transcript ---');
  console.log(json.transcript ?? json.artifact?.transcript ?? '(sin transcript)');
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
