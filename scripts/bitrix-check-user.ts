import 'dotenv/config';

// Solo-lectura: verifica que uno o más IDs de usuario de Bitrix existan y muestra su nombre/estado.
// Útil para confirmar los IDs de asesores antes de cablearlos en CAMPAIGN_MMD_ASESORES.
// Auto-contenido (fetch directo al webhook admin con timeout). Uso:
//   npx tsx scripts/bitrix-check-user.ts 3515 709431

const WEBHOOK = (process.env.BITRIX_WEBHOOK_URL ?? '').replace(/\/$/, '');
const TIMEOUT_MS = 20_000;

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

async function main() {
  if (!WEBHOOK) throw new Error('Falta BITRIX_WEBHOOK_URL en .env');
  const ids = (process.argv.slice(2).length ? process.argv.slice(2) : ['3515', '709431']).map((s) => Number(s));
  console.log(`Verificando ${ids.length} usuario(s)…\n`);
  for (const id of ids) {
    try {
      const r = await call('user.get', { ID: id });
      const u = (r.result ?? [])[0];
      if (!u) {
        console.log(`  [${id}]  ❌ NO existe (sin resultado)`);
        continue;
      }
      const nombre = [u.NAME, u.LAST_NAME].filter(Boolean).join(' ') || '(sin nombre)';
      const activo = u.ACTIVE === true || u.ACTIVE === 'Y' ? 'activo' : 'INACTIVO';
      console.log(`  [${id}]  ${nombre}  ·  ${activo}  ·  ${u.WORK_POSITION ?? '—'}  ·  ${u.EMAIL ?? '—'}`);
    } catch (e) {
      console.log(`  [${id}]  ❌ ${String(e)}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('❌', e);
    process.exit(1);
  });
