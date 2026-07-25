import { config } from '../src/config';

// Dispara una llamada de prueba de la campaña MMD vía el endpoint /voice/outbound, leyendo el secreto
// y la BASE_URL del entorno (sin exponerlos). Auto-contenido (solo importa config → sin Redis).
// Uso: railway run -- npx tsx scripts/disparar-llamada-campana.ts <dealId> [nombre] [telefono]
async function main() {
  const dealId = Number(process.argv[2]);
  const nombre = process.argv[3] || 'Rodrigo';
  const phone = process.argv[4] || '+56923883848';
  if (!dealId) throw new Error('Uso: disparar-llamada-campana.ts <dealId> [nombre] [telefono]');
  if (!config.baseUrl || !config.vapiSecret) throw new Error('Faltan BASE_URL / VAPI_SECRET en el entorno.');

  const r = await fetch(`${config.baseUrl}/voice/outbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-vapi-secret': config.vapiSecret },
    body: JSON.stringify({ phone, programCode: 'MMD', dealId, nombre }),
  });
  const j = await r.json().catch(() => ({}));
  console.log('HTTP', r.status, JSON.stringify(j));
  if (!r.ok) process.exit(1);
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
