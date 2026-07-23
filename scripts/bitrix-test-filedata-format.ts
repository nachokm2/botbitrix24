import { config } from '../src/config';

// Prueba el formato { fileData: [nombre, base64] } (objeto, no array plano) para setear un UF tipo
// Archivo — es distinto de lo ya probado y es el que documenta Bitrix24 para crm.*.update.
// Uso: railway run -- npx tsx scripts/bitrix-test-filedata-format.ts <dealId> <fileId> <ufCode>
async function main() {
  const dealId = Number(process.argv[2]);
  const fileId = Number(process.argv[3]);
  const ufCode = process.argv[4] || 'UF_CRM_BROCHURE_PROGRAMA_V2';
  const base = config.bitrixWebhookUrl.replace(/\/$/, '');
  const call = async (method: string, body: unknown) => {
    const r = await fetch(`${base}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.json();
  };

  const fileInfo: any = await call('disk.file.get', { id: fileId });
  const downloadUrl = fileInfo?.result?.DOWNLOAD_URL;
  const fileName = fileInfo?.result?.NAME ?? `brochure-${fileId}.pdf`;
  if (!downloadUrl) throw new Error('Sin DOWNLOAD_URL: ' + JSON.stringify(fileInfo));

  const rFile = await fetch(downloadUrl);
  const buf = Buffer.from(await rFile.arrayBuffer());
  const b64 = buf.toString('base64');
  console.log('descargado:', fileName, buf.length, 'bytes');

  const upd: any = await call('crm.deal.update', {
    id: dealId,
    fields: { [ufCode]: { fileData: [fileName, b64] } },
  });
  console.log('update result:', JSON.stringify(upd?.result ?? upd?.error, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('❌', e);
    process.exit(1);
  });
