import { config } from '../src/config';

// Lista los PDFs disponibles en cada carpeta de brochures del Drive (para elegir un programa real
// al probar buscarBrochureDrive). Uso: npx tsx scripts/bitrix-list-drive-brochures.ts
async function listar(nombre: string, folderId: string) {
  if (!folderId) return console.log(nombre, ': sin carpeta configurada');
  const base = config.bitrixWebhookUrl.replace(/\/$/, '');
  let start = 0;
  const nombres: string[] = [];
  for (;;) {
    const r = await fetch(`${base}/disk.folder.getchildren`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: folderId, start }),
    });
    const json: any = await r.json();
    for (const it of json.result ?? []) if (it.TYPE === 'file') nombres.push(it.NAME);
    if (json.next === undefined || json.next === null) break;
    start = json.next;
  }
  console.log(`\n${nombre} (${folderId}):`);
  nombres.forEach((n) => console.log(' -', n));
}

async function main() {
  await listar('Magíster', config.driveFolderMagister);
  await listar('Diplomado', config.driveFolderDiplomado);
  await listar('Especialidad', config.driveFolderEspecialidad);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('❌', e);
    process.exit(1);
  });
