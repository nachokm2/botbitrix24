/**
 * Lista las plantillas aprobadas de la licencia de ChatApp, con su UUID.
 *
 *   npm run chatapp-plantillas
 *   npm run chatapp-plantillas -- 50126     (otra licencia)
 *
 * El UUID es lo que hay que poner en PRIMER_CONTACTO_PLANTILLA: la API identifica la plantilla por
 * id, no por su nombre en Meta. Sirve además para comprobar que las credenciales funcionan.
 */
import { listarPlantillas } from '../src/whatsapp/chatapp';
import { config } from '../src/config';

async function main() {
  const licencia = Number(process.argv[2] ?? config.chatappLicenseId) || config.chatappLicenseId;
  if (!licencia) {
    console.error('Define CHATAPP_LICENSE_ID o pásalo como argumento.');
    process.exit(1);
  }
  const items = await listarPlantillas(licencia);
  console.log(`\nLicencia ${licencia} · ${items.length} plantillas\n`);
  for (const t of items) {
    const marca = t.status === 'APPROVED' ? '✓' : '·';
    console.log(`${marca} ${t.id}`);
    console.log(`    nombre: ${t.elementName}   idioma: ${t.languageCode}   estado: ${t.status}   tipo: ${t.templateType}`);
    console.log(`    texto:  ${String(t.data ?? '').replace(/\s+/g, ' ').slice(0, 150)}`);
    console.log('');
  }
  if (!items.some((t) => t.status === 'APPROVED')) {
    console.log('Ninguna plantilla aprobada todavía: hay que crearla y que Meta la apruebe.');
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
