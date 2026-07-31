import { actualizarDatosCliente } from '../src/crm/crmWrite';

// Simula que la persona ahora muestra interés en OTRO programa sobre un deal/contacto ya
// existentes (mismo código real que usa el bot) — confirma que se adjunta el nuevo brochure
// (reemplazando el anterior) y se dispara un nuevo correo, solo para este programa.
// Uso: npx tsx scripts/bitrix-test-brochure-cambio.ts <dealId> <contactId> "<programa>"
async function main() {
  const dealId = Number(process.argv[2]);
  const contactId = Number(process.argv[3]);
  const programa = process.argv[4];
  if (!dealId || !contactId || !programa) throw new Error('Uso: <dealId> <contactId> "<programa>"');

  const auth = { domain: '', access_token: '' } as any;
  const r = await actualizarDatosCliente(
    { deal: dealId, contact: contactId },
    undefined,
    { programa_interes: programa },
    auth,
  );
  console.log('actualizarDatosCliente resultado:', JSON.stringify(r, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('❌', e);
    process.exit(1);
  });
