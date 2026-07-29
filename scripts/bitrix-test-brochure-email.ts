import { config } from '../src/config';
import { actualizarDatosCliente } from '../src/crm/crmWrite';

// Prueba end-to-end del flujo real de envío del brochure: crea un contacto+deal de prueba (email
// del propio equipo, para no mandarle un correo real a un prospecto), llama a
// actualizarDatosCliente (el mismo código que usa el bot en producción) con un programa de interés
// real, y deja los IDs para revisar en Bitrix24 / la bandeja de correo.
// Uso: npx tsx scripts/bitrix-test-brochure-email.ts <email-destino>
async function main() {
  const emailDestino = process.argv[2];
  if (!emailDestino) throw new Error('Uso: bitrix-test-brochure-email.ts <email-destino>');

  const base = config.bitrixWebhookUrl.replace(/\/$/, '');
  const call = async (method: string, body: unknown) => {
    const r = await fetch(`${base}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await r.json();
    if (json.error) throw new Error(`${method}: ${JSON.stringify(json)}`);
    return json.result;
  };

  const contactId: number = await call('crm.contact.add', {
    fields: {
      NAME: 'Prueba Brochure Bot',
      EMAIL: [{ VALUE: emailDestino, VALUE_TYPE: 'WORK' }],
    },
  });
  console.log('Contacto de prueba:', contactId);

  const dealId: number = await call('crm.deal.add', {
    fields: {
      TITLE: 'Prueba envío de brochure (bot)',
      CONTACT_ID: contactId,
    },
  });
  console.log('Deal de prueba:', dealId);

  const auth = { domain: '', access_token: '' } as any;
  const r = await actualizarDatosCliente(
    { deal: dealId, contact: contactId },
    undefined,
    { programa_interes: 'Magíster en Inteligencia Artificial' },
    auth,
  );
  console.log('actualizarDatosCliente resultado:', JSON.stringify(r, null, 2));

  console.log('\n--- Revisa ---');
  console.log('Deal:', dealId, '/ Contacto:', contactId);
  console.log('Bandeja de:', emailDestino);
  console.log(
    `Para borrar la prueba después: npx tsx scripts/bitrix-delete-deal.ts ${dealId}  (y borra el contacto ${contactId} a mano si quieres)`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('❌', e);
    process.exit(1);
  });
