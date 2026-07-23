import { config } from '../src/config';
import { callCrm } from '../src/bitrix/client';

// Crea el campo personalizado tipo "Archivo" en el Deal para guardar el brochure (PDF del Drive)
// que corresponde al "programa de interés" actual. Usa el webhook admin (BITRIX_WEBHOOK_URL) — no
// importa '../src/store' (evita levantar el cliente Redis, que cuelga el proceso en un shell local).
// Uso: railway run -- npx tsx scripts/bitrix-create-brochure-field.ts
async function main() {
  if (!config.bitrixWebhookUrl) {
    throw new Error('Falta BITRIX_WEBHOOK_URL en el entorno (el webhook admin, con permisos de escritura en crm).');
  }
  const EMPTY_AUTH = { domain: '', access_token: '' } as any;
  const r: any = await callCrm(
    'crm.deal.userfield.add',
    {
      fields: {
        FIELD_NAME: 'BROCHURE_PROGRAMA',
        EDIT_FORM_LABEL: { es: 'Brochure del programa', en: 'Program brochure' },
        LIST_COLUMN_LABEL: { es: 'Brochure', en: 'Brochure' },
        LIST_FILTER_LABEL: { es: 'Brochure', en: 'Brochure' },
        USER_TYPE_ID: 'file',
        XML_ID: 'UF_BROCHURE_PROGRAMA',
        MULTIPLE: 'N',
        MANDATORY: 'N',
        SHOW_IN_LIST: 'Y',
        EDIT_IN_LIST: 'Y',
        IS_SEARCHABLE: 'N',
      },
    },
    EMPTY_AUTH,
  );
  console.log('✅ Campo creado. ID:', r);

  const fields: any = await callCrm('crm.deal.userfield.list', { filter: { ID: r } }, EMPTY_AUTH);
  console.log(JSON.stringify(fields, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('❌', e);
    process.exit(1);
  });
