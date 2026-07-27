// Lista TODOS los programas del catálogo que consultar_programas ya NO propone, agrupados por motivo.
// Uso: npx tsx scripts/listado-excluidos.ts
import { PROGRAMAS } from '../src/ai/catalog';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { programas } = JSON.parse(
  readFileSync(fileURLToPath(new URL('../src/core/condicionesComerciales.data.json', import.meta.url)), 'utf8'),
) as { programas: Array<{ nombre: string; codigo: string | null; estado: string; cotizable: boolean; motivo?: string }> };

const acc = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const normP = (s: string) =>
  acc(s).replace(/^(magister|diplomado|especialidad|master)\s+(en|de|del|de la)\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
function match(nombre: string) {
  const q = normP(nombre);
  if (!q) return [] as typeof programas;
  const ex = programas.filter((p) => normP(p.nombre) === q);
  if (ex.length) return ex;
  return programas.filter((p) => {
    const n = normP(p.nombre);
    return n.includes(q) || q.includes(n);
  });
}

const ETIQUETA: Record<string, string> = {
  masivo_no_habilitado: 'BECA / MASIVO (arancel liberado, no habilitado para venta)',
  suspendido: 'SUSPENDIDO',
  pausa: 'EN PAUSA',
  'matrícula_cerrada': 'MATRÍCULA CERRADA',
  nuevo_sin_precio: 'NUEVO (sin precio confirmado)',
  bloqueado: 'BLOQUEADO / sin datos comerciales',
  sin_datos_planilla: 'NO ESTÁ EN LA PLANILLA (ausencia real)',
};

const excl: Record<string, string[]> = {};
for (const c of PROGRAMAS) {
  const m = match(c.nombre);
  if (m.some((p) => p.cotizable)) continue; // sí se propone
  const reason = m.length === 0 ? 'sin_datos_planilla' : m[0].motivo ?? acc(m[0].estado).replace(/\s+/g, '_');
  (excl[reason] ??= []).push(c.nombre);
}

const total = Object.values(excl).reduce((a, b) => a + b.length, 0);
console.log(`\nProgramas EXCLUIDOS de las recomendaciones: ${total} (de ${PROGRAMAS.length} del catálogo)\n`);
for (const key of Object.keys(ETIQUETA)) {
  const arr = excl[key];
  if (!arr?.length) continue;
  console.log(`━━━ ${ETIQUETA[key]}: ${arr.length} ━━━`);
  arr.sort().forEach((n) => console.log('   • ' + n));
  console.log('');
}
// Cualquier motivo no mapeado:
for (const key of Object.keys(excl)) {
  if (ETIQUETA[key]) continue;
  console.log(`━━━ ${key}: ${excl[key].length} ━━━`);
  excl[key].sort().forEach((n) => console.log('   • ' + n));
  console.log('');
}
