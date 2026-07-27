// Para los programas del catálogo SIN match estricto en la planilla comercial, busca el "gemelo" más
// parecido por solapamiento de palabras. Distingue variantes de nombre (mismo programa, mal escrito)
// de ausencias reales. Uso: npx tsx scripts/audit-sin-datos.ts
import { PROGRAMAS } from '../src/ai/catalog';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { programas } = JSON.parse(
  readFileSync(fileURLToPath(new URL('../src/core/condicionesComerciales.data.json', import.meta.url)), 'utf8'),
) as { programas: Array<{ nombre: string; codigo: string | null; estado: string; cotizable: boolean }> };

const acc = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
// norm con quita de prefijo de tipo, igual que el módulo (para el match ESTRICTO).
const normP = (s: string) =>
  acc(s)
    .replace(/^(magister|diplomado|especialidad|master)\s+(en|de|del|de la)\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const STOP = new Set(['en', 'de', 'del', 'la', 'el', 'los', 'las', 'y', 'e', 'o', 'para', 'con', 'al', 'un', 'una', 'por', 'a', 'magister', 'diplomado', 'especialidad', 'master', 'medica', 'medico']);
const toks = (s: string) => new Set(acc(s).replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length >= 3 && !STOP.has(w)));
const jaccard = (a: Set<string>, b: Set<string>) => {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const uni = a.size + b.size - inter;
  return uni ? inter / uni : 0;
};

// Match estricto (exacto normalizado o "contiene"), replicando matchPrograma:
function tieneMatchEstricto(nombre: string): boolean {
  const q = normP(nombre);
  if (programas.some((p) => normP(p.nombre) === q)) return true;
  return programas.some((p) => {
    const n = normP(p.nombre);
    return n.includes(q) || q.includes(n);
  });
}

const sinDatos = PROGRAMAS.filter((c) => !tieneMatchEstricto(c.nombre));

type Fila = { catalogo: string; twin: string; codigo: string | null; estado: string; score: number };
const filas: Fila[] = sinDatos.map((c) => {
  const tc = toks(c.nombre);
  let best = { p: null as any, score: 0 };
  for (const p of programas) {
    const s = jaccard(tc, toks(p.nombre));
    if (s > best.score) best = { p, score: s };
  }
  return {
    catalogo: c.nombre,
    twin: best.p?.nombre ?? '—',
    codigo: best.p?.codigo ?? null,
    estado: best.p?.estado ?? '',
    score: best.score,
  };
});

const variantes = filas.filter((f) => f.score >= 0.6).sort((a, b) => b.score - a.score);
const dudosos = filas.filter((f) => f.score >= 0.35 && f.score < 0.6).sort((a, b) => b.score - a.score);
const ausentes = filas.filter((f) => f.score < 0.35).sort((a, b) => a.catalogo.localeCompare(b.catalogo));

console.log(`\nProgramas del catálogo SIN match estricto en la planilla: ${sinDatos.length}\n`);
console.log(`━━━ PROBABLE VARIANTE DE NOMBRE (mismo programa, ≥0.6): ${variantes.length} ━━━`);
for (const f of variantes) console.log(`  "${f.catalogo}"\n     ≈ ${f.twin}  [${f.codigo} · ${f.estado}]  (score ${f.score.toFixed(2)})`);
console.log(`\n━━━ DUDOSO (revisar, 0.35–0.6): ${dudosos.length} ━━━`);
for (const f of dudosos) console.log(`  "${f.catalogo}"\n     ≈ ${f.twin}  [${f.codigo} · ${f.estado}]  (score ${f.score.toFixed(2)})`);
console.log(`\n━━━ PROBABLE AUSENCIA REAL (<0.35): ${ausentes.length} ━━━`);
for (const f of ausentes) console.log(`  "${f.catalogo}"`);
console.log('');
