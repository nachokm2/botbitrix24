// Genera src/core/condicionesComerciales.data.json a partir de la capa de datos en markdown
// (data/capa-datos-postgrados.md). Re-ejecutable cuando la Dirección de Postgrados actualice la planilla:
//   npx tsx scripts/build-condiciones.ts
// Parsea 4 secciones con esquemas de columnas distintos:
//   §6 tabla maestra (148) · §7 masivos (21) · §8 nuevos sin precio (no cotizar) · §9 bloqueados.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = resolve('data/capa-datos-postgrados.md');
const OUT = resolve('src/core/condicionesComerciales.data.json');

// ── Helpers de parseo de celdas ──
const stripBold = (s: string) => s.replace(/\*\*/g, '').trim();
const money = (s: string): number | null => {
  const t = stripBold(s).replace(/[$.\s]/g, '');
  if (!t || /^[⬜—-]+$/.test(stripBold(s))) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const pct = (s: string): number | null => {
  const t = stripBold(s).replace(/[%\s]/g, '');
  if (!t || /^[⬜—-]+$/.test(stripBold(s))) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const codigo = (s: string): string | null => {
  const t = s.replace(/`/g, '').trim();
  return /^[A-Z]{2,4}-[A-Z]{2,4}-\d+$/i.test(t) ? t.toUpperCase() : null;
};
const cuota = (s: string): { monto: number; n: number } | null => {
  const m = stripBold(s).match(/\$?([\d.]+)\s*x\s*(\d+)/i);
  if (!m) return null;
  return { monto: Number(m[1].replace(/\./g, '')), n: Number(m[2]) };
};
const estadoOf = (s: string) => stripBold(s).toUpperCase() || 'ACTIVO';
// De la modalidad ("Presencial Santiago", "Semipresencial Temuco", "Online") saca base + sede.
function modalidadSede(s: string): { modalidad: string; sede: string | null } {
  const t = stripBold(s);
  const sede = /santiago/i.test(t) ? 'Santiago' : /temuco/i.test(t) ? 'Temuco' : null;
  const modalidad = /semipresencial/i.test(t) ? 'Semipresencial' : /presencial/i.test(t) ? 'Presencial' : 'Online';
  return { modalidad, sede };
}
// Cuotas máximas Toku por tipo de programa (confirmado: Diplomado 5, Magíster 24; Máster/Especialidad pendientes).
function cuotasPorTipo(tipo: string): number | null {
  if (/especialidad/i.test(tipo)) return null; // POR CONFIRMAR
  if (/máster|master/i.test(tipo)) return null; // POR CONFIRMAR
  if (/magíster|magister/i.test(tipo)) return 24;
  if (/diplomado/i.test(tipo)) return 5;
  return null;
}

type Row = {
  codigo: string | null;
  nombre: string;
  tipo: string;
  area: string;
  modalidad: string;
  sede: string | null;
  matricula: number | null;
  arancelLista: number | null;
  dtoPct: number | null;
  arancelConDto: number | null;
  total: number | null;
  cuota: { monto: number; n: number } | null;
  cuotasMaxTipo: number | null;
  estado: string;
  cotizable: boolean;
  motivo?: string;
};

// Divide una fila markdown en celdas (quita los pipes de borde).
function cells(line: string): string[] {
  const parts = line.split('|');
  return parts.slice(1, parts.length - 1).map((c) => c.trim());
}
function isDataRow(line: string): boolean {
  if (!/^\s*\|/.test(line)) return false;
  const c = cells(line);
  if (c.length === 0) return false;
  const first = c[0].replace(/`/g, '').trim();
  if (first === 'Código' || /^-+$/.test(first)) return false; // header o separador
  return true;
}

const md = readFileSync(SRC, 'utf8');
const lines = md.split(/\r?\n/);

// Trocea por secciones "## N."
type Section = { n: number; lines: string[] };
const sections: Section[] = [];
let cur: Section | null = null;
for (const line of lines) {
  const h = line.match(/^##\s+(\d+)\./);
  if (h) {
    cur = { n: Number(h[1]), lines: [] };
    sections.push(cur);
  } else if (cur) {
    cur.lines.push(line);
  }
}
const sec = (n: number) => sections.find((s) => s.n === n)?.lines ?? [];

const rows: Row[] = [];

// §6 — Tabla maestra: Código|Programa|Tipo|Área|Modalidad|Matrícula|Arancel lista|Dto.|Arancel c/dto|Total|Cuota máx.|Estado
for (const line of sec(6).filter(isDataRow)) {
  const c = cells(line);
  if (c.length < 12) continue;
  const { modalidad, sede } = modalidadSede(c[4]);
  const estado = estadoOf(c[11]);
  const arancelConDto = money(c[8]);
  rows.push({
    codigo: codigo(c[0]),
    nombre: stripBold(c[1]),
    tipo: stripBold(c[2]),
    area: stripBold(c[3]),
    modalidad,
    sede,
    matricula: money(c[5]),
    arancelLista: money(c[6]),
    dtoPct: pct(c[7]),
    arancelConDto,
    total: money(c[9]),
    cuota: cuota(c[10]),
    cuotasMaxTipo: cuotasPorTipo(c[2]),
    estado,
    cotizable: estado === 'ACTIVO' && arancelConDto !== null,
    ...(estado !== 'ACTIVO' ? { motivo: estado.toLowerCase().replace(/\s+/g, '_') } : {}),
  });
}

// §7 — Masivos: Código|Programa|Área|Matrícula|Arancel lista|Dto.|Arancel c/dto|Total|Cuota máx.
// Los de arancel liberado 100% son BECAS aún NO habilitadas para venta: no se proponen ni se cotizan
// (motivo masivo_no_habilitado). Excepción: DI-DAT-024 mantiene 30% → es venta normal (cotizable).
for (const line of sec(7).filter(isDataRow)) {
  const c = cells(line);
  if (c.length < 8) continue;
  const dtoPct = pct(c[5]);
  const arancelConDto = money(c[6]);
  const esBeca = dtoPct === 100; // arancel liberado: beca, otra fecha de salida, no habilitada aún
  rows.push({
    codigo: codigo(c[0]),
    nombre: stripBold(c[1]),
    tipo: 'Diplomado',
    area: stripBold(c[2]),
    modalidad: 'Online',
    sede: null,
    matricula: money(c[3]),
    arancelLista: money(c[4]),
    dtoPct,
    arancelConDto,
    total: money(c[7]),
    cuota: c[8] ? cuota(c[8]) : null,
    cuotasMaxTipo: 5,
    estado: 'ACTIVO',
    cotizable: !esBeca && arancelConDto !== null,
    ...(esBeca ? { motivo: 'masivo_no_habilitado' } : {}),
  });
}

// §8 — Nuevos sin precio confirmado: no cotizar. Código|Programa|Tipo|Matrícula ref.|Arancel ref.|Dto. ref.|Estado web
for (const line of sec(8).filter(isDataRow)) {
  const c = cells(line);
  if (c.length < 7) continue;
  rows.push({
    codigo: codigo(c[0]),
    nombre: stripBold(c[1]),
    tipo: stripBold(c[2]),
    area: '',
    modalidad: '',
    sede: null,
    matricula: money(c[3]),
    arancelLista: money(c[4]),
    dtoPct: pct(c[5]),
    arancelConDto: null, // precio de lista referencial, NO confirmado → nunca cotizar
    total: null,
    cuota: null,
    cuotasMaxTipo: cuotasPorTipo(c[2]),
    estado: 'NUEVO',
    cotizable: false,
    motivo: 'nuevo_sin_precio',
  });
}

// §9 — Bloqueados: Código|Programa|Estado  (algunos sin código)
for (const line of sec(9).filter(isDataRow)) {
  const c = cells(line);
  if (c.length < 3) continue;
  rows.push({
    codigo: codigo(c[0]),
    nombre: stripBold(c[1]),
    tipo: '',
    area: '',
    modalidad: '',
    sede: null,
    matricula: null,
    arancelLista: null,
    dtoPct: null,
    arancelConDto: null,
    total: null,
    cuota: null,
    cuotasMaxTipo: null,
    estado: estadoOf(c[2]),
    cotizable: false,
    motivo: 'bloqueado',
  });
}

const salida = {
  _fuente: 'data/capa-datos-postgrados.md (Planilla maestra 2026, Dirección de Postgrados UA)',
  _generado: 'scripts/build-condiciones.ts — NO editar a mano; re-generar desde la fuente',
  programas: rows,
};
writeFileSync(OUT, JSON.stringify(salida, null, 2) + '\n', 'utf8');

// Resumen para verificación
const cotizables = rows.filter((r) => r.cotizable).length;
const porEstado: Record<string, number> = {};
for (const r of rows) porEstado[r.estado] = (porEstado[r.estado] ?? 0) + 1;
console.log(`OK → ${OUT}`);
console.log(`Total programas: ${rows.length} · cotizables (ACTIVO c/precio): ${cotizables}`);
console.log('Por estado:', porEstado);
const mmd = rows.find((r) => r.codigo === 'MAG-MAR-175');
console.log('Spot-check Marketing Digital:', JSON.stringify(mmd));
