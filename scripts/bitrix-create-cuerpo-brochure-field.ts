import { config } from '../src/config';
import { callCrm } from '../src/bitrix/client';

// Crea el campo personalizado tipo "String" en el Deal para guardar el CUERPO del correo del
// brochure ya renderizado por el bot (con todos los programas acumulados de la conversación) —
// la plantilla bizproc solo lo referencia vía {=Document:...}, sin necesitar loops nativos.
// Uso: npx tsx scripts/bitrix-create-cuerpo-brochure-field.ts
async function main() {
  if (!config.bitrixWebhookUrl) {
    throw new Error('Falta BITRIX_WEBHOOK_URL en el entorno.');
  }
  const EMPTY_AUTH = { domain: '', access_token: '' } as any;
  const r: any = await callCrm(
    'crm.deal.userfield.add',
    {
      fields: {
        FIELD_NAME: 'CUERPO_BROCHURE_HTML',
        EDIT_FORM_LABEL: { es: 'Cuerpo del correo (brochure)', en: 'Brochure email body' },
        LIST_COLUMN_LABEL: { es: 'Cuerpo brochure', en: 'Brochure body' },
        LIST_FILTER_LABEL: { es: 'Cuerpo brochure', en: 'Brochure body' },
        USER_TYPE_ID: 'string',
        XML_ID: 'UF_CUERPO_BROCHURE_HTML',
        MULTIPLE: 'N',
        MANDATORY: 'N',
        SHOW_IN_LIST: 'N',
        EDIT_IN_LIST: 'N',
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
