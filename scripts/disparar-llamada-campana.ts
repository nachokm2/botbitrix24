import { config } from '../src/config';

// Dispara una o VARIAS llamadas de prueba de la campaña MMD vía /voice/outbound, leyendo el secreto y
// la BASE_URL del entorno (sin exponerlos). Con varios objetivos, se disparan EN PARALELO (Promise.all).
// Auto-contenido (solo importa config → sin Redis).
// Uso:
//   1 llamada:  railway run -- npx tsx scripts/disparar-llamada-campana.ts <dealId> [nombre] [telefono]
//   N llamadas: railway run -- npx tsx scripts/disparar-llamada-campana.ts dealId:telefono:nombre  dealId:telefono:nombre ...
//   ej: ... 3360477:+56923883848:Rodrigo 3361615:+56949041383:Magdalena

type Target = { dealId: number; phone: string; nombre: string };

async function disparar(t: Target): Promise<boolean> {
  try {
    const r = await fetch(`${config.baseUrl}/voice/outbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vapi-secret': config.vapiSecret },
      body: JSON.stringify({ phone: t.phone, programCode: 'MMD', dealId: t.dealId, nombre: t.nombre }),
    });
    const j: any = await r.json().catch(() => ({}));
    console.log(`deal ${t.dealId} (${t.nombre} · ${t.phone}) → HTTP ${r.status} · callId=${j.callId ?? '—'}`);
    return r.ok;
  } catch (e) {
    console.log(`deal ${t.dealId} (${t.nombre}) → ERROR ${String(e)}`);
    return false;
  }
}

async function main() {
  if (!config.baseUrl || !config.vapiSecret) throw new Error('Faltan BASE_URL / VAPI_SECRET en el entorno.');
  const args = process.argv.slice(2);
  if (!args.length) throw new Error('Uso: <dealId> [nombre] [telefono]  |  dealId:telefono:nombre ...');

  let targets: Target[];
  if (args.some((a) => a.includes(':'))) {
    targets = args.map((a) => {
      const [d, p, n] = a.split(':');
      return { dealId: Number(d), phone: p, nombre: n || 'Prospecto' };
    });
  } else {
    targets = [{ dealId: Number(args[0]), nombre: args[1] || 'Rodrigo', phone: args[2] || '+56923883848' }];
  }

  console.log(`Disparando ${targets.length} llamada(s) en paralelo…`);
  const results = await Promise.all(targets.map(disparar));
  const ok = results.filter(Boolean).length;
  console.log(`\n${ok}/${targets.length} llamadas iniciadas.`);
  if (ok < targets.length) process.exit(1);
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
