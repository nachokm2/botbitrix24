import { config } from '../src/config';

// Utilidad genérica: borra un deal por ID. Uso: railway run -- npx tsx scripts/bitrix-delete-deal.ts <dealId>
async function main() {
  const dealId = Number(process.argv[2]);
  const base = config.bitrixWebhookUrl.replace(/\/$/, '');
  const r = await fetch(`${base}/crm.deal.delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: dealId }),
  });
  console.log(await r.text());
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('❌', e);
    process.exit(1);
  });
