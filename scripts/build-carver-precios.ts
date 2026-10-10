/**
 * Genera src/ai/carver.condiciones.data.json desde data/carver/precios-carver.csv.
 *
 * La fuente es la planilla de precios de Carver validada con la dirección (2026-10-10). NO editar el
 * JSON a mano: corregir el CSV y volver a correr `npx tsx scripts/build-carver-precios.ts`.
 *
 * Las notas del CSV traen, en prosa, las tres formas de pago. Se parsean acá para que el bot reciba
 * cifras y no un párrafo: cotizar leyendo prosa es justamente como se dicen números equivocados.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Pago = { n: number; monto: number };
type ProgramaCarver = {
  nombre: string;
  tipo: string;
  gratis?: boolean;
  certificadoUsd?: number;
  arancelLista?: number;
  becaPct?: number;
  arancelConBeca?: number;
  /** Solo se cobra en la modalidad de mensualidades (contado y semestral no la llevan). */
  matricula?: number;
  matriculaRegular?: number;
  mensualidades?: Pago;
  semestral?: Pago;
  contado?: { total: number; porAnio?: number; anios?: number };
  cotizable: boolean;
  motivoNoCotizable?: string;
};

// Los cursos traen 0 en las columnas de precio, no vacío: un 0 significa "no aplica", no "cuesta 0".
const num = (s?: string) => {
  if (!s || s.trim() === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
const SI = new Set(['si', 'sí', 's', 'true', '1']);

function parseLinea(linea: string): string[] {
  // El CSV se genera sin comillas internas salvo en las notas; se parte en 9 campos y el último
  // (notas) absorbe cualquier ';' que traiga el texto.
  const partes = linea.split(';');
  return partes.length <= 9 ? partes : [...partes.slice(0, 8), partes.slice(8).join(';')];
}

const csv = readFileSync(fileURLToPath(new URL('../data/carver/precios-carver.csv', import.meta.url)), 'utf8');
const lineas = csv.split(/\r?\n/).filter((l) => l.trim() !== '');
lineas.shift(); // cabecera

const programas: ProgramaCarver[] = [];
for (const linea of lineas) {
  const [tipo, nombre, arancel, matricula, dto, cuotasN, cuotaUsd, vende, notas = ''] = parseLinea(linea);
  const seVende = SI.has(String(vende).trim().toLowerCase());
  const cuposCompletos = /cupos completos/i.test(notas);

  const arancelNum = num(arancel);
  if (/gratis/i.test(notas) && !arancelNum) {
    const cert = notas.match(/certificado,?\s*cuesta USD\s*(\d+)/i);
    programas.push({
      nombre,
      tipo,
      gratis: true,
      certificadoUsd: cert ? Number(cert[1]) : undefined,
      cotizable: seVende,
    });
    continue;
  }

  const lista = arancelNum;
  const becaPct = num(dto);
  const sem = notas.match(/Pago semestral:\s*USD\s*([\d.]+)\s*por semestre\s*\((\d+)\s*pagos?\)/i);
  const contadoAnual = notas.match(/Contado:\s*USD\s*([\d.]+)\s*por año durante\s*(\d+)\s*años/i);
  const contadoTotal = notas.match(/Contado:\s*USD\s*([\d.]+)\s*por todo el programa/i);
  const matRegular = notas.match(/Matrícula regular USD\s*(\d+)/i);

  programas.push({
    nombre,
    tipo,
    arancelLista: lista,
    becaPct,
    arancelConBeca: lista && becaPct ? Math.round(lista * (1 - becaPct / 100)) : undefined,
    matricula: num(matricula),
    matriculaRegular: matRegular ? Number(matRegular[1]) : undefined,
    mensualidades: num(cuotasN) && num(cuotaUsd) ? { n: num(cuotasN)!, monto: num(cuotaUsd)! } : undefined,
    semestral: sem ? { n: Number(sem[2]), monto: Number(sem[1].replace('.', '')) } : undefined,
    contado: contadoAnual
      ? {
          total: Number(contadoAnual[1].replace('.', '')) * Number(contadoAnual[2]),
          porAnio: Number(contadoAnual[1].replace('.', '')),
          anios: Number(contadoAnual[2]),
        }
      : contadoTotal
        ? { total: Number(contadoTotal[1].replace('.', '')) }
        : undefined,
    cotizable: seVende,
    motivoNoCotizable: seVende ? undefined : cuposCompletos ? 'cupos completos' : 'no disponible',
  });
}

const salida = {
  _fuente: 'data/carver/precios-carver.csv — planilla validada con la dirección de Carver',
  _generado: 'scripts/build-carver-precios.ts — NO editar a mano; corregir el CSV y regenerar',
  programas,
};
const destino = fileURLToPath(new URL('../src/ai/carver.condiciones.data.json', import.meta.url));
writeFileSync(destino, JSON.stringify(salida, null, 1), 'utf8');
console.log(`${programas.length} programas → ${destino}`);
console.log(`  con arancel: ${programas.filter((p) => p.arancelLista).length} | gratis: ${programas.filter((p) => p.gratis).length} | cotizables: ${programas.filter((p) => p.cotizable).length}`);
