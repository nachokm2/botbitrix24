import { kvDel } from '../src/store/kv';

// Borra el estado acumulado de "programas de interés ya brochureados" de un deal — útil para
// re-probar el flujo desde cero. Uso: npx tsx scripts/bitrix-clear-brochure-acumulado.ts <dealId>
async function main() {
  const dealId = Number(process.argv[2]);
  if (!dealId) throw new Error('Uso: <dealId>');
  await kvDel(`brochure:programas:${dealId}`);
  console.log('borrado: brochure:programas:' + dealId);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('❌', e);
    process.exit(1);
  });
