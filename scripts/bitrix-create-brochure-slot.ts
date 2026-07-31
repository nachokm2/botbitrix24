import { config } from '../src/config';
import { callCrm } from '../src/bitrix/client';

// Crea un campo personalizado tipo "Archivo" adicional en el Deal, para un "slot" extra de
// brochure (cuando hay varios programas de interés y se quieren adjuntar como archivos separados
// en vez de fusionados en un solo PDF). Reusa la misma receta que ya funcionó para el slot 1
// (BROCHURE_PROGRAMA / UF_CRM_BROCHURE_PROGRAMA_V2).
// Uso: npx tsx scripts/bitrix-create-brochure-slot.ts <numeroDeSlot>
async function main() {
  const slot = process.argv[2];
  if (!slot) throw new Error('Uso: <numeroDeSlot> (ej. 2, 3)');
  if (!config.bitrixWebhookUrl) throw new Error('Falta BITRIX_WEBHOOK_URL en el entorno.');

  const EMPTY_AUTH = { domain: '', access_token: '' } as any;
  const r: any = await callCrm(
    'crm.deal.userfield.add',
    {
      fields: {
        FIELD_NAME: `BROCHURE_PROGRAMA_${slot}`,
        EDIT_FORM_LABEL: { es: `Brochure del programa ${slot}`, en: `Program brochure ${slot}` },
        LIST_COLUMN_LABEL: { es: `Brochure ${slot}`, en: `Brochure ${slot}` },
        LIST_FILTER_LABEL: { es: `Brochure ${slot}`, en: `Brochure ${slot}` },
        USER_TYPE_ID: 'file',
        XML_ID: `UF_BROCHURE_PROGRAMA_${slot}`,
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
