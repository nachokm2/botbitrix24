import { config } from '../src/config';

// Diagnóstico: revisa la vinculación CRM de un diálogo de Open Lines (WhatsApp) + su historial.
// Uso: npx tsx scripts/diag-dialogo.ts <dialogId (chatNNNNN o y|whatsapp|...)>
async function main() {
  const dialogId = process.argv[2];
  if (!dialogId) throw new Error('Uso: <dialogId>');
  const base = config.bitrixWebhookUrl.replace(/\/$/, '');
  const call = async (method: string, body: unknown) => {
    const r = await fetch(`${base}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.json();
  };
  const chatId = dialogId.replace(/^chat/, '');
  const dlg: any = await call('imopenlines.dialog.get', { CHAT_ID: chatId });
  console.log('dialog.get:', JSON.stringify(dlg, null, 2));

  const hist: any = await call('imopenlines.history.get', { CHAT_ID: chatId, LIMIT: 30 });
  console.log('--- history (últimos mensajes) ---');
  const msgs = hist?.result ?? hist;
  console.log(JSON.stringify(msgs, null, 2)?.slice(0, 4000));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('❌', e);
    process.exit(1);
  });
