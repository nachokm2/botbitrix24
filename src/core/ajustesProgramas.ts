import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from '../config';
import { marca } from '../marca';
import { PROGRAMAS } from '../ai/catalog';
import { DETALLES, type DetallePrograma } from '../ai/detalles';
import { esTipoComercializable } from './oferta';
// Solo tipos: en ejecución este módulo no depende de ajustes.ts ni de condicionesCarver.ts, que son
// los que lo usan a él.
import type { ErrorCampo, Validacion } from './ajustes';
import type { ProgramaCarver } from './condicionesCarver';

/**
 * Secciones "Programas y modalidad" y "Precios" del panel de configuración (ver core/ajustes.ts).
 *
 * Lo que se edita son los programas que el bot OFRECE: en Carver, licenciaturas y maestrías. Los cursos
 * cortos siguen en el catálogo como referencia, pero no se venden por este canal (core/oferta.ts), así
 * que no tiene sentido editarlos.
 *
 * La base son los mismos archivos de siempre —catálogo, detalle y planilla de precios—, y lo publicado
 * se aplica encima, programa por programa. Con los valores por defecto el resultado es idéntico a la
 * base (lo comprueba test/ajustesProgramas.test.ts): instalar estas secciones no cambia nada hasta que
 * alguien publique.
 *
 * Lo que NO se edita acá: la fecha de inicio. Carver ya tiene un calendario de ingresos validado en el
 * conocimiento institucional, y una segunda fuente de fechas terminaría contradiciéndolo.
 */

export type Disponibilidad = 'abierto' | 'cupos_completos';

export type ProgramaAjustable = {
  /** Nombre y tipo vienen del catálogo y no se editan: van para que el historial se lea solo. */
  nombre: string;
  tipo: string;
  disponibilidad: Disponibilidad;
  /** Cuándo vuelve a abrir la matrícula, en palabras ("marzo de 2027"). Solo con cupos completos. */
  reabre: string;
  modalidad: string;
  duracion: string;
  /** Vacío = el programa no tiene brochure y el bot lo dice en vez de inventar un enlace. */
  brochureUrl: string;
};
export type AjustesProgramas = { programas: Record<string, ProgramaAjustable> };

/** Precios de un programa como los piensa quien los fija: el arancel con beca y el monto de cada cuota
 *  se CALCULAN (ver precioACondicion), así no pueden quedar contradiciéndose con el resto. */
export type PrecioAjustable = {
  nombre: string;
  tipo: string;
  arancelLista: number;
  becaPct: number;
  matricula: number;
  matriculaRegular: number;
  cuotas: number;
  semestralPagos: number;
  semestralMonto: number;
  contadoTotal: number;
  /** 1 = un solo pago. Más de 1 = contado ANUAL (las licenciaturas: USD 585 por año durante 4 años). */
  contadoAnios: number;
};
/** vigenciaHasta: hasta cuándo se dan estos precios por revisados (AAAA-MM-DD). Pasada esa fecha el
 *  bot los entrega como referencia y ofrece confirmarlos (core/vigencia.ts). Vacío = sin fecha. */
export type AjustesPrecios = { vigenciaHasta: string; programas: Record<string, PrecioAjustable> };

/** Lo que decía el código antes de que esto fuera editable. */
export const REABRE_POR_DEFECTO = 'marzo de 2027';

type ProgramaBase = { slug: string; nombre: string; tipo: string; detalle: DetallePrograma; condicion: ProgramaCarver };

const slugDe = (url: string) => url.replace(/\/+$/, '').split('/').pop() ?? url;

let baseCache: ProgramaBase[] | null = null;

/** Programas ofrecidos, con su detalle y su precio de los archivos. Vacío fuera de Carver. */
export function programasBase(): ProgramaBase[] {
  if (baseCache) return baseCache;
  if (marca.catalogo !== 'carver') return (baseCache = []);
  const condiciones = (
    JSON.parse(readFileSync(fileURLToPath(new URL('../ai/carver.condiciones.data.json', import.meta.url)), 'utf8')) as {
      programas: ProgramaCarver[];
    }
  ).programas;
  const out: ProgramaBase[] = [];
  for (const p of PROGRAMAS) {
    if (!esTipoComercializable(p.tipo)) continue;
    const slug = slugDe(p.url);
    const detalle = DETALLES[slug];
    const condicion = condiciones.find((c) => c.nombre === p.nombre);
    // Sin detalle o sin precio no hay nada que editar con sentido; las pruebas verifican que no falte ninguno.
    if (detalle && condicion) out.push({ slug, nombre: p.nombre, tipo: p.tipo, detalle, condicion });
  }
  return (baseCache = out);
}

const brochureDe = (d: DetallePrograma) => String((d as any).brochurePdfUrl ?? d.brochureUrl ?? '');

export function programasPorDefecto(): AjustesProgramas {
  const programas: Record<string, ProgramaAjustable> = {};
  for (const b of programasBase()) {
    const cupos = !b.condicion.cotizable && b.condicion.motivoNoCotizable === 'cupos completos';
    programas[b.slug] = {
      nombre: b.nombre,
      tipo: b.tipo,
      disponibilidad: b.condicion.cotizable === false ? 'cupos_completos' : 'abierto',
      reabre: cupos ? REABRE_POR_DEFECTO : '',
      modalidad: String(b.detalle.modalidad ?? ''),
      duracion: String(b.detalle.duracion ?? ''),
      brochureUrl: brochureDe(b.detalle),
    };
  }
  return { programas };
}

export function preciosPorDefecto(): AjustesPrecios {
  const programas: Record<string, PrecioAjustable> = {};
  for (const b of programasBase()) {
    const c = b.condicion;
    programas[b.slug] = {
      nombre: b.nombre,
      tipo: b.tipo,
      arancelLista: c.arancelLista ?? 0,
      becaPct: c.becaPct ?? 0,
      matricula: c.matricula ?? 0,
      matriculaRegular: c.matriculaRegular ?? 0,
      cuotas: c.mensualidades?.n ?? 0,
      semestralPagos: c.semestral?.n ?? 0,
      semestralMonto: c.semestral?.monto ?? 0,
      contadoTotal: c.contado?.total ?? 0,
      contadoAnios: c.contado?.anios ?? 1,
    };
  }
  // Se lee config en cada llamada: así las pruebas de core/vigencia.ts y un cambio en Railway siguen
  // rigiendo mientras nadie publique precios desde el panel.
  return { vigenciaHasta: config.condicionesVigenciaHasta, programas };
}

// ── Validación ───────────────────────────────────────────────────────────────────────────────────
// Los mensajes los lee alguien que no programa: dicen qué corregir, no qué regla se violó.

const MAX_MONTO = 100_000;

/** ¿El monto se puede cobrar tal cual, en centavos? Tolera el error de coma flotante de JavaScript. */
const enCentavos = (n: number) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6;
const redondear = (n: number) => Math.round(n * 100) / 100;
const usd = (n: number) => `USD ${n.toLocaleString('es-CL', { maximumFractionDigits: 2 })}`;
const esEntero = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);
const esMonto = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && enCentavos(x);

function fechaValida(texto: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) return false;
  const d = new Date(`${texto}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === texto;
}

/**
 * ¿Se puede publicar este enlace? Además de exigir https, se rechazan direcciones internas: el bot
 * descarga el enlace para verificarlo (core/brochures.ts), y apuntarlo a la red interna de Railway
 * sería usar al bot para leer servicios que no son públicos. Devuelve el motivo, o null si sirve.
 */
export function motivoEnlaceInvalido(texto: string): string | null {
  let u: URL;
  try {
    u = new URL(texto);
  } catch {
    return 'No es un enlace válido. Pega la dirección completa, que empiece con https://';
  }
  if (u.protocol !== 'https:') return 'El enlace debe empezar con https://';
  const host = u.hostname.toLowerCase();
  const interno =
    !host.includes('.') ||
    host === 'localhost' ||
    /\.(internal|local|localhost)$/.test(host) ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
    host.startsWith('[');
  if (interno) return 'Ese enlace no es una dirección pública de internet.';
  if (texto.length > 500) return 'El enlace es demasiado largo.';
  return null;
}

const objeto = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {};

export function validarProgramas(entrada: unknown): Validacion<AjustesProgramas> {
  const x = objeto(entrada);
  const errores: ErrorCampo[] = [];
  if (x.programas !== undefined && (typeof x.programas !== 'object' || Array.isArray(x.programas))) {
    return { ok: false, errores: [{ campo: 'programas', mensaje: 'La lista de programas no es válida.' }] };
  }
  const recibidos = objeto(x.programas);
  const defecto = programasPorDefecto().programas;
  const programas: Record<string, ProgramaAjustable> = {};

  // Se recorre la BASE y no lo recibido: un programa que dejó de existir se ignora en vez de invalidar
  // toda la sección, y uno nuevo que todavía no estaba publicado entra con sus valores de siempre.
  for (const b of programasBase()) {
    const p = { ...defecto[b.slug], ...objeto(recibidos[b.slug]) } as Record<string, unknown>;
    const error = (campo: string, mensaje: string) => errores.push({ campo: `programas.${b.slug}.${campo}`, mensaje });

    const disponibilidad = p.disponibilidad;
    if (disponibilidad !== 'abierto' && disponibilidad !== 'cupos_completos') error('disponibilidad', 'Elige si el programa está abierto a matrícula o con cupos completos.');
    const reabre = String(p.reabre ?? '').trim();
    if (disponibilidad === 'cupos_completos' && !reabre) error('reabre', 'Indica cuándo vuelve a abrir la matrícula (por ejemplo, «marzo de 2027»).');
    if (reabre.length > 60) error('reabre', 'Escríbelo en pocas palabras (hasta 60 letras).');

    const modalidad = String(p.modalidad ?? '').trim();
    if (!modalidad) error('modalidad', 'Describe la modalidad: el bot la usa para responder.');
    if (modalidad.length > 600) error('modalidad', 'La descripción de la modalidad es demasiado larga (hasta 600 letras).');
    const duracion = String(p.duracion ?? '').trim();
    if (!duracion) error('duracion', 'Indica la duración (por ejemplo, «12 meses de clases»).');
    if (duracion.length > 80) error('duracion', 'Escribe la duración en pocas palabras (hasta 80 letras).');

    const brochureUrl = String(p.brochureUrl ?? '').trim();
    const motivo = brochureUrl ? motivoEnlaceInvalido(brochureUrl) : null;
    if (motivo) error('brochureUrl', motivo);

    programas[b.slug] = {
      nombre: b.nombre,
      tipo: b.tipo,
      disponibilidad: disponibilidad === 'cupos_completos' ? 'cupos_completos' : 'abierto',
      // Con el programa abierto no hay reapertura que anunciar: se guarda vacío para que no quede un
      // dato viejo esperando a que alguien vuelva a cerrar los cupos.
      reabre: disponibilidad === 'cupos_completos' ? reabre : '',
      modalidad,
      duracion,
      brochureUrl,
    };
  }
  if (errores.length) return { ok: false, errores };
  return { ok: true, valor: { programas } };
}

export function validarPrecios(entrada: unknown): Validacion<AjustesPrecios> {
  const x = objeto(entrada);
  const errores: ErrorCampo[] = [];
  if (x.programas !== undefined && (typeof x.programas !== 'object' || Array.isArray(x.programas))) {
    return { ok: false, errores: [{ campo: 'programas', mensaje: 'La lista de programas no es válida.' }] };
  }
  const vigenciaHasta = String(x.vigenciaHasta ?? '').trim();
  if (vigenciaHasta && !fechaValida(vigenciaHasta)) errores.push({ campo: 'vigenciaHasta', mensaje: 'La fecha de vigencia no es válida.' });

  const recibidos = objeto(x.programas);
  const defecto = preciosPorDefecto().programas;
  const programas: Record<string, PrecioAjustable> = {};

  for (const b of programasBase()) {
    const p = { ...defecto[b.slug], ...objeto(recibidos[b.slug]) } as Record<string, unknown>;
    const error = (campo: string, mensaje: string) => errores.push({ campo: `programas.${b.slug}.${campo}`, mensaje });
    const monto = (campo: string, nombre: string, minimo: number) => {
      const v = p[campo];
      if (!esMonto(v) || v < minimo || v > MAX_MONTO) {
        error(campo, minimo > 0 ? `${nombre} debe ser un monto en dólares mayor que 0.` : `${nombre} debe ser un monto en dólares (0 si no se cobra).`);
        return null;
      }
      return v;
    };
    const entero = (campo: string, mensaje: string, min: number, max: number) => {
      const v = p[campo];
      if (!esEntero(v) || v < min || v > max) {
        error(campo, mensaje);
        return null;
      }
      return v;
    };

    const lista = monto('arancelLista', 'El arancel de lista', 1);
    const beca = entero('becaPct', 'La beca debe ser un porcentaje entero entre 0 y 95.', 0, 95);
    const matricula = monto('matricula', 'La matrícula', 0);
    const matriculaRegular = monto('matriculaRegular', 'La matrícula regular', 0);
    const cuotas = entero('cuotas', 'El número de cuotas debe ser un entero entre 1 y 60.', 1, 60);
    const semPagos = entero('semestralPagos', 'El número de pagos semestrales debe ser un entero entre 1 y 12.', 1, 12);
    const semMonto = monto('semestralMonto', 'El pago semestral', 1);
    const contado = monto('contadoTotal', 'El pago al contado', 1);
    const anios = entero('contadoAnios', 'Los años del pago al contado deben ser un entero entre 1 y 10.', 1, 10);

    if (matricula !== null && matriculaRegular !== null && matriculaRegular < matricula) {
      error('matriculaRegular', 'La matrícula regular no puede ser menor que la matrícula con beca.');
    }
    let conBeca: number | null = null;
    if (lista !== null && beca !== null) {
      conBeca = (lista * (100 - beca)) / 100;
      if (!enCentavos(conBeca)) {
        error('becaPct', `Con esa beca el arancel quedaría en ${usd(conBeca)}, con fracción de centavo. Revisa el arancel o el porcentaje.`);
        conBeca = null;
      }
    }
    if (conBeca !== null && cuotas !== null && !enCentavos(conBeca / cuotas)) {
      error(
        'cuotas',
        `Con ${cuotas} cuotas, cada una sería de ${usd(conBeca / cuotas)}. Elige un número de cuotas que divida exacto el arancel con beca (${usd(conBeca)}).`,
      );
    }
    if (contado !== null && anios !== null && !enCentavos(contado / anios)) {
      error('contadoAnios', `Repartido en ${anios} años, cada pago sería de ${usd(contado / anios)}. Revisa el total o los años.`);
    }
    // La forma de pago más corta nunca cuesta más que una más larga: es lo que la hace atractiva, y una
    // planilla que lo contradice casi siempre es un dígito mal puesto.
    const totalSemestral = semPagos !== null && semMonto !== null ? redondear(semPagos * semMonto) : null;
    if (contado !== null && totalSemestral !== null && contado > totalSemestral) {
      error('contadoTotal', `El pago al contado (${usd(contado)}) no puede costar más que el total semestral (${usd(totalSemestral)}).`);
    }
    if (totalSemestral !== null && conBeca !== null && totalSemestral > conBeca) {
      error('semestralMonto', `El total semestral (${usd(totalSemestral)}) no puede costar más que el total en cuotas (${usd(conBeca)}).`);
    }

    programas[b.slug] = {
      nombre: b.nombre,
      tipo: b.tipo,
      arancelLista: lista ?? 0,
      becaPct: beca ?? 0,
      matricula: matricula ?? 0,
      matriculaRegular: matriculaRegular ?? 0,
      cuotas: cuotas ?? 0,
      semestralPagos: semPagos ?? 0,
      semestralMonto: semMonto ?? 0,
      contadoTotal: contado ?? 0,
      contadoAnios: anios ?? 1,
    };
  }
  if (errores.length) return { ok: false, errores };
  return { ok: true, valor: { vigenciaHasta, programas } };
}

// ── Lo publicado, aplicado sobre los datos de siempre ────────────────────────────────────────────

let slugPorNombre: Map<string, string> | null = null;
const slugDelPrograma = (nombre: string) => {
  slugPorNombre ??= new Map(programasBase().map((b) => [b.nombre, b.slug]));
  return slugPorNombre.get(nombre);
};

/** Los precios de un programa en la forma que usa la cotización (core/condicionesCarver.ts). */
export function precioACondicion(p: PrecioAjustable): Pick<ProgramaCarver, 'arancelLista' | 'becaPct' | 'arancelConBeca' | 'matricula' | 'matriculaRegular' | 'mensualidades' | 'semestral' | 'contado'> {
  const conBeca = redondear((p.arancelLista * (100 - p.becaPct)) / 100);
  return {
    arancelLista: p.arancelLista,
    becaPct: p.becaPct,
    arancelConBeca: conBeca,
    matricula: p.matricula,
    matriculaRegular: p.matriculaRegular,
    mensualidades: { n: p.cuotas, monto: redondear(conBeca / p.cuotas) },
    semestral: { n: p.semestralPagos, monto: p.semestralMonto },
    contado:
      p.contadoAnios > 1
        ? { total: p.contadoTotal, porAnio: redondear(p.contadoTotal / p.contadoAnios), anios: p.contadoAnios }
        : { total: p.contadoTotal },
  };
}

/** Condiciones de un programa con lo publicado en "Programas y modalidad" y en "Precios". Los
 *  programas que no se editan desde el panel (los cursos) pasan intactos. */
export function aplicarAjustesACondicion(
  c: ProgramaCarver,
  programas: AjustesProgramas,
  precios: AjustesPrecios,
): ProgramaCarver & { reabre?: string } {
  const slug = slugDelPrograma(c.nombre);
  if (!slug) return c;
  const prog = programas.programas[slug];
  const precio = precios.programas[slug];
  let out: ProgramaCarver & { reabre?: string } = { ...c };
  if (precio) out = { ...out, ...precioACondicion(precio) };
  if (prog) {
    const cupos = prog.disponibilidad === 'cupos_completos';
    out.cotizable = !cupos;
    if (cupos) out.motivoNoCotizable = 'cupos completos';
    else delete out.motivoNoCotizable;
    if (cupos) out.reabre = prog.reabre;
  }
  return out;
}

/** El detalle de un programa con lo publicado en "Programas y modalidad". Solo se toca lo que cambió:
 *  sin cambios devuelve el mismo objeto, con sus campos tal cual (incluido el PDF directo, si lo hay). */
export function aplicarAjustesADetalle(d: DetallePrograma, programas: AjustesProgramas): DetallePrograma {
  const slug = slugDe(d.url ?? '');
  const prog = programas.programas[slug];
  if (!prog) return d;
  const out: DetallePrograma & { brochurePdfUrl?: string } = { ...d };
  let cambio = false;
  if (prog.modalidad !== String(d.modalidad ?? '')) {
    out.modalidad = prog.modalidad;
    cambio = true;
  }
  if (prog.duracion !== String(d.duracion ?? '')) {
    out.duracion = prog.duracion;
    cambio = true;
  }
  if (prog.brochureUrl !== brochureDe(d)) {
    // El enlace nuevo reemplaza a los dos: si quedara el PDF directo de antes, ganaría sobre el nuevo.
    delete out.brochurePdfUrl;
    out.brochureUrl = prog.brochureUrl || null;
    cambio = true;
  }
  return cambio ? out : d;
}
