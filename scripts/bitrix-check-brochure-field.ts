import { callCrm } from '../src/bitrix/client';

// Solo-lectura: ¿ya existe el campo BROCHURE_PROGRAMA? (evita crear un duplicado si el intento
// anterior sí alcanzó a llegar antes de que el proceso se colgara). No importa '../src/store'
// (evita levantar el cliente Redis, que cuelga el proceso en un shell local).
async function main() {
  const auth = { domain: '', access_token: '' } as any;
  const all: any[] = await callCrm('crm.deal.userfield.list', {}, auth);
  const match = all.filter((f: any) => String(f.FIELD_NAME ?? '').includes('BROCHURE'));
  console.log(`Total campos UF del Deal: ${all.length}`);
  console.log('Coinciden con BROCHURE:', JSON.stringify(match, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('❌', e);
    process.exit(1);
  });
