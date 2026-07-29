import { config } from '../src/config';

// Renombra el asistente en el dashboard de Vapi a "Sofía" (campo `name` del assistant; es la etiqueta
// interna de Vapi, no afecta lo que escucha el cliente —eso lo da el prompt/firstMessage—).
// Uso: railway run -- npx tsx scripts/vapi-set-name.ts
async function main() {
  if (!config.vapiApiKey || !config.vapiAssistantId) {
    throw new Error('Faltan VAPI_API_KEY / VAPI_ASSISTANT_ID en el entorno.');
  }
  const r = await fetch(`https://api.vapi.ai/assistant/${config.vapiAssistantId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${config.vapiApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Sofía' }),
  });
  const json: any = await r.json();
  if (!r.ok) {
    console.error('❌ Vapi respondió', r.status, JSON.stringify(json));
    process.exit(1);
  }
  console.log('✅ Nombre del asistente Vapi actualizado a:', json?.name ?? '(sin campo name en la respuesta)');
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
