import { config } from '../src/config';
import { callWebhook, callBitrix } from '../src/bitrix/client';
import { getState } from '../src/store';

// F1-T2: valida acceso al CRM (crm.item.list de Deals).
// Usa BITRIX_WEBHOOK_URL si está definido (rápido), si no usa el auth OAuth almacenado tras /install.
async function main() {
  if (config.bitrixWebhookUrl) {
    const r: any = await callWebhook('crm.item.list', { entityTypeId: 2, start: 0 }, config.bitrixWebhookUrl);
    console.log('✅ OK (webhook). Deals devueltos:', r.items?.length ?? r);
    return;
  }

  const st = await getState();
  if (!st.auth) {
    throw new Error(
      'No hay auth OAuth almacenada. Instala el app (/install) o define BITRIX_WEBHOOK_URL en .env.',
    );
  }
  const r: any = await callBitrix('crm.item.list', { entityTypeId: 2, start: 0 }, st.auth);
  console.log('✅ OK (oauth). Deals devueltos:', r.items?.length ?? r);
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
