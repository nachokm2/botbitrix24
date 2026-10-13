/**
 * Verifica, contra los enlaces REALES, el brochure de cada programa de la oferta comercial: que el
 * enlace responda, que detrás haya un PDF (o el visor de un PDF) y que ese PDF sea el del programa.
 *
 *   MARCA=carver npx tsx scripts/verificar-brochures.ts
 *
 * Solo hace lecturas HTTP públicas: no escribe nada en ningún sistema. Sale con código 1 si algún
 * programa quedaría sin brochure, para usarlo como control antes de desplegar o tras cambiar el catálogo.
 */
import './aislar-regresion';
import { PROGRAMAS } from '../src/ai/catalog';
import { obtenerBrochure } from '../src/core/brochures';
import { esTipoComercializable } from '../src/core/oferta';
import { marca } from '../src/marca';

async function main() {
  const programas = PROGRAMAS.filter((p) => esTipoComercializable(p.tipo));
  console.log(`Brochures · marca ${marca.key} · ${programas.length} programas comercializables\n`);
  let fallas = 0;
  const formatos: Record<string, number> = {};
  for (const p of programas) {
    const r = await obtenerBrochure({ programa: p.nombre });
    if (r.ok) {
      formatos[r.formato] = (formatos[r.formato] ?? 0) + 1;
      console.log(`✓ ${p.nombre} → ${r.formato}${r.archivo ? ` (${r.archivo})` : ''}`);
    } else {
      fallas++;
      console.log(`✗ ${p.nombre} → ${r.motivo}`);
    }
  }
  console.log(`\n${programas.length - fallas}/${programas.length} verificados · formatos: ${JSON.stringify(formatos)}`);
  process.exit(fallas ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
