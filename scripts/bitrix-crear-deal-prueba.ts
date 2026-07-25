import 'dotenv/config';

// Crea deals de PRUEBA para el agente de voz saliente MMD: un contacto con un teléfono dado + N deals
// en el embudo Maestrías (CATEGORY_ID=3). Auto-contenido (fetch directo al webhook + timeout).
// Uso: npx tsx scripts/bitrix-crear-deal-prueba.ts [telefono] [nombre] [cantidad]
//   ej: npx tsx scripts/bitrix-crear-deal-prueba.ts +56923883848 Rodrigo 2
// Limpieza posterior: scripts/bitrix-delete-deal.ts

const WEBHOOK = (process.env.BITRIX_WEBHOOK_URL ?? '').replace(/\/$/, '');
const TIMEOUT_MS = 20_000;

const TELEFONO = process.argv[2] || '+56923883848';
const NOMBRE = process.argv[3] || 'Rodrigo';
const CANTIDAD = Math.max(1, Math.min(5, Number(process.argv[4] || 2)));
const CATEGORY_ID = Number(process.env.CAMPAIGN_MMD_CATEGORY_ID || 3);
const UF_PROGRAMA = process.env.BITRIX_UF_PROGRAMA || '';
const PROGRAMA = 'Magíster en Marketing Digital';

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
  console.log(`Creando contacto de prueba (${NOMBRE}, ${TELEFONO})…`);
  const c = await call('crm.contact.add', {
    fields: {
      NAME: NOMBRE,
      LAST_NAME: 'Prueba IA',
      PHONE: [{ VALUE: TELEFONO, VALUE_TYPE: 'MOBILE' }],
      OPENED: 'Y',
      SOURCE_ID: 'OTHER',
      COMMENTS: 'Contacto de PRUEBA del agente de voz saliente MMD.',
    },
  });
  const contactId = Number(c.result);
  console.log(`  ✅ Contacto #${contactId}`);

  const dealIds: number[] = [];
  for (let i = 1; i <= CANTIDAD; i++) {
    const fields: any = {
      TITLE: `🧪 PRUEBA ${i} — ${PROGRAMA} — ${NOMBRE}`,
      CATEGORY_ID,
      STAGE_ID: `C${CATEGORY_ID}:NEW`,
      CONTACT_ID: contactId,
      OPENED: 'Y',
      COMMENTS: 'Deal de PRUEBA para el agente de voz saliente MMD. Borrar tras la prueba.',
    };
    if (UF_PROGRAMA) fields[UF_PROGRAMA] = PROGRAMA;
    const d = await call('crm.deal.add', { fields });
    const dealId = Number(d.result);
    dealIds.push(dealId);
    console.log(`  ✅ Deal #${dealId} (${fields.TITLE})`);
  }

  console.log('\n── Para disparar la llamada de prueba (una por deal) ──');
  for (const id of dealIds) {
    console.log(`dealId=${id}`);
  }
  console.log(`\ncontactId=${contactId}  ·  deals=${dealIds.join(',')}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('❌', e);
    process.exit(1);
  });
