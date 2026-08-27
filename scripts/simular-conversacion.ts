// Simula una conversación real de punta a punta contra /webchat/message (mismo motor que WhatsApp,
// perfil WEB) en el bot desplegado. Uso: npx tsx scripts/simular-conversacion.ts <etiqueta> "<msg1>" "<msg2>" ...
async function main() {
  const base = (process.env.BASE_URL || 'https://botbitrix24-production.up.railway.app').replace(/\/$/, '');
  const etiqueta = process.argv[2];
  const mensajes = process.argv.slice(3);
  if (!etiqueta || !mensajes.length) throw new Error('Uso: <etiqueta> "<msg1>" "<msg2>" ...');

  let conversationId: string | undefined;
  for (const message of mensajes) {
    const body: any = { message };
    if (conversationId) body.conversationId = conversationId;
    const r = await fetch(`${base}/webchat/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify(body),
    });
    const json: any = await r.json();
    if (!r.ok) {
      console.log(`[${etiqueta}] ERROR HTTP ${r.status}:`, JSON.stringify(json));
      continue;
    }
    conversationId = json.conversationId;
    console.log(`[${etiqueta}] > ${message}`);
    console.log(`[${etiqueta}] < ${json.reply}\n`);
  }
  console.log(`[${etiqueta}] conversationId final: ${conversationId}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('❌', e);
    process.exit(1);
  });
