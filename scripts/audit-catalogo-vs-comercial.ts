// Auditoría: cruza el catálogo de retrieval (lo que consultar_programas PUEDE proponer, ya sin masivos)
// contra el estado comercial de cada programa (condicionesComerciales). Lista los que se podrían
// proponer pero NO se pueden cotizar (pausa/suspendido/cerrada/nuevo/bloqueado) o que no están en la
// planilla comercial. Re-ejecutable: npx tsx scripts/audit-catalogo-vs-comercial.ts
import { PROGRAMAS } from '../src/ai/catalog';
import { buscarCondiciones, esProgramaCotizable } from '../src/core/condicionesComerciales';

// Lo que consultar_programas realmente propone hoy (solo cotizables):
const proponibles = PROGRAMAS.filter((p) => esProgramaCotizable(p.nombre));
const excluidos = PROGRAMAS.length - proponibles.length;

const cotizable: string[] = [];
const noCotizable: string[] = [];
const ambiguo: string[] = [];
const noEncontrado: string[] = [];

for (const p of proponibles) {
  const r: any = buscarCondiciones(p.nombre);
  if (r.encontrado === false) noEncontrado.push(p.nombre);
  else if (r.ambiguo) ambiguo.push(`${p.nombre} → ${r.opciones.map((o: any) => `${o.sede ?? '?'}:${o.estado}`).join(' / ')}`);
  else if (r.cotizable) cotizable.push(p.nombre);
  else noCotizable.push(`${p.nombre}  [${r.motivo}]`);
}

const line = (s: string) => console.log(s);
line('');
line(`Catálogo (PROGRAMAS): ${PROGRAMAS.length} · excluidos (no cotizables/sin datos): ${excluidos} · proponibles hoy: ${proponibles.length}`);
line('─'.repeat(80));
line(`✅ Proponibles Y cotizables (OK): ${cotizable.length}`);
line('');
line(`⚠️  Proponibles pero NO cotizables (el bot los recomienda y luego no puede cotizar): ${noCotizable.length}`);
noCotizable.sort().forEach((x) => line('    ' + x));
line('');
line(`~  Ambiguos por sede (revisar estado por sede): ${ambiguo.length}`);
ambiguo.sort().forEach((x) => line('    ' + x));
line('');
line(`?  Proponibles SIN datos comerciales (no están en la planilla 2026): ${noEncontrado.length}`);
noEncontrado.sort().forEach((x) => line('    ' + x));
line('');
