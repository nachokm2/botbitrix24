import { config } from '../src/config';

// Verifica que el TEMPLATE_ID dado corresponda al flujo de envío del brochure (busca el
// CrmSendEmailActivity y confirma que referencia nuestros campos, no contenido de prueba viejo).
async function main() {
  const id = process.argv[2];
  const base = config.bitrixWebhookUrl.replace(/\/$/, '');
  const r = await fetch(`${base}/bizproc.workflow.template.list`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ FILTER: { ID: id }, SELECT: ['ID', 'NAME', 'DOCUMENT_TYPE', 'TEMPLATE'] }),
  });
  const json: any = await r.json();
  const t = json.result?.[0];
  if (!t) return console.log('No se encontró la plantilla', id, JSON.stringify(json));
  console.log('NAME:', t.NAME);
  console.log('DOCUMENT_TYPE:', JSON.stringify(t.DOCUMENT_TYPE));

  function findByType(node: any, type: string, out: any[]) {
    if (Array.isArray(node)) { for (const n of node) findByType(n, type, out); return; }
    if (node && typeof node === 'object') {
      if (node.Type === type) out.push(node);
      if (node.Children) findByType(node.Children, type, out);
    }
  }
  const emails: any[] = [];
  findByType(t.TEMPLATE, 'CrmSendEmailActivity', emails);
  console.log('CrmSendEmailActivity encontradas:', emails.length);
  console.log(JSON.stringify(emails, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('❌', e);
    process.exit(1);
  });
