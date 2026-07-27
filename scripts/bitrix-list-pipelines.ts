import 'dotenv/config';

// Solo-lectura: lista los embudos (pipelines/categorías) de deals y sus etapas (STAGE_ID + nombre),
// para configurar CAMPAIGN_MMD_CATEGORY_ID y las CAMPAIGN_MMD_STAGE_*. Auto-contenido: fetch directo
// al webhook admin (BITRIX_WEBHOOK_URL) con timeout, sin importar el cliente de la app.
// Uso: npx tsx scripts/bitrix-list-pipelines.ts   (o filtrando: ... 3   para ver solo la categoría 3)

const WEBHOOK = (process.env.BITRIX_WEBHOOK_URL ?? '').replace(/\/$/, '');
const TIMEOUT_MS = 20_000;
const soloCat = process.argv[2] ? Number(process.argv[2]) : null;

async function call(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${WEBHOOK}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: ctrl.signal,
    });
    const json: any = await res.json().catch(() => ({ error: `HTTP ${res.status}: no-JSON` }));
    if (json.error) throw new Error(`${method}: ${json.error} ${json.error_description ?? ''}`);
    return json;
  } finally {
    clearTimeout(t);
  }
}

async function stages(catId: number): Promise<{ id: string; name: string }[]> {
  const r = await call('crm.dealcategory.stage.list', { id: catId });
  return (r.result ?? []).map((s: any) => ({ id: s.STATUS_ID, name: s.NAME }));
}

async function main() {
  if (!WEBHOOK) throw new Error('Falta BITRIX_WEBHOOK_URL en .env');
  console.log(`Webhook: ${WEBHOOK.replace(/\/[^/]+\/[^/]+$/, '/****/****')}\n`);

  // La categoría 0 (General) no viene en dealcategory.list: se agrega a mano.
  const r = await call('crm.dealcategory.list', {});
  const cats: { id: number; name: string }[] = [{ id: 0, name: 'General (por defecto)' }];
  for (const c of r.result ?? []) cats.push({ id: Number(c.ID), name: String(c.NAME) });
  cats.sort((a, b) => a.id - b.id);

  console.log(`── Embudos (${cats.length}) ──`);
  for (const c of cats) console.log(`  [${c.id}]  ${c.name}`);

  // Etapas: de la categoría pedida por argumento, o de las candidatas a Magíster/Marketing Digital.
  const objetivo = soloCat != null
    ? cats.filter((c) => c.id === soloCat)
    : cats.filter((c) => c.id === 3 || /mag[íi]ster|market|digital/i.test(c.name));

  for (const c of objetivo) {
    console.log(`\n── Etapas del embudo [${c.id}] ${c.name} ──`);
    try {
      for (const s of await stages(c.id)) console.log(`  ${s.id.padEnd(28)} ${s.name}`);
    } catch (e) {
      console.log(`  (no se pudieron leer: ${String(e)})`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('❌', e);
    process.exit(1);
  });
