import { getJson } from '../src/store/kv';

// Diagnóstico: busca el diálogo de WhatsApp de origen de una llamada (guardado por solicitar_llamada).
// Uso: npx tsx scripts/diag-origen-llamada.ts <callId>
async function main() {
  const callId = process.argv[2];
  if (!callId) throw new Error('Uso: <callId>');
  const o = await getJson<any>(`vapi:origen:${callId}`);
  console.log('origen:', JSON.stringify(o));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('❌', e);
    process.exit(1);
  });
