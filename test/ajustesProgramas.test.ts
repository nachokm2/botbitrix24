import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Secciones "Programas y modalidad" y "Precios" del panel de configuración (Carver).
// Lo más importante: mientras nadie publique, el bot cotiza, enlaza y describe EXACTAMENTE como antes.
process.env.MARCA = 'carver';
process.env.REDIS_URL = '';
process.env.NODE_ENV = 'test';

const ap = await import('../src/core/ajustesProgramas');
const { _fijarPublicadaParaPruebas, seccionesDisponibles } = await import('../src/core/ajustes');
const { buscarCondicionesCarver, matchProgramaCarver } = await import('../src/core/condicionesCarver');
const { enlaceDePago } = await import('../src/core/mediosPago');
const { consultarProgramas, detallePrograma } = await import('../src/core/catalogTool');
const { obtenerBrochure, _limpiarCacheBrochures } = await import('../src/core/brochures');
const { estadoVigencia } = await import('../src/core/vigencia');
const { DETALLES } = await import('../src/ai/detalles');
const { readFileSync } = await import('node:fs');

const CONDICIONES = JSON.parse(readFileSync(new URL('../src/ai/carver.condiciones.data.json', import.meta.url), 'utf8')).programas as any[];
const slugDe = (nombre: string) => ap.programasBase().find((b) => b.nombre === nombre)!.slug;
const PSICO = 'Maestría en Psicología';
const LIC_ADM = 'Licenciatura en Administración de Empresas'; // hoy con cupos completos

beforeEach(() => {
  _fijarPublicadaParaPruebas('programas', null);
  _fijarPublicadaParaPruebas('precios', null);
});

/** Precios por defecto con un cambio en un programa. */
function preciosCon(nombre: string, cambio: Record<string, unknown>) {
  const d = ap.preciosPorDefecto();
  const slug = slugDe(nombre);
  return { ...d, programas: { ...d.programas, [slug]: { ...d.programas[slug], ...cambio } } };
}
function programasCon(nombre: string, cambio: Record<string, unknown>) {
  const d = ap.programasPorDefecto();
  const slug = slugDe(nombre);
  return { programas: { ...d.programas, [slug]: { ...d.programas[slug], ...cambio } } };
}
const publicar = (seccion: 'programas' | 'precios', contenido: unknown) => {
  const v = (seccion === 'programas' ? ap.validarProgramas : ap.validarPrecios)(contenido);
  assert.ok(v.ok, `la versión de prueba debe ser válida: ${JSON.stringify(!v.ok && v.errores)}`);
  _fijarPublicadaParaPruebas(seccion, v.valor);
};

// ── Sin publicar, nada cambia ────────────────────────────────────────────────────────────────────
test('las 16 licenciaturas y maestrías tienen detalle y precio; los cursos no se editan', () => {
  const base = ap.programasBase();
  assert.equal(base.length, 16);
  assert.ok(base.every((b) => b.tipo === 'licenciatura' || b.tipo === 'maestria'));
  assert.deepEqual(seccionesDisponibles(), ['horarios', 'programas', 'precios', 'conocimiento', 'comportamiento', 'acciones']);
});

test('los valores por defecto cumplen las reglas (si no, el panel no podría ni abrir)', () => {
  assert.ok(ap.validarProgramas(ap.programasPorDefecto()).ok);
  assert.ok(ap.validarPrecios(ap.preciosPorDefecto()).ok);
});

test('con los valores por defecto, la planilla de cada programa queda idéntica', () => {
  const programas = ap.programasPorDefecto();
  const precios = ap.preciosPorDefecto();
  for (const c of CONDICIONES) {
    const { reabre, ...resto } = ap.aplicarAjustesACondicion(c, programas, precios);
    assert.deepEqual(resto, c, c.nombre);
    if (c.motivoNoCotizable === 'cupos completos') assert.equal(reabre, 'marzo de 2027', c.nombre);
    else assert.equal(reabre, undefined, c.nombre);
  }
});

test('con los valores por defecto, el detalle de cada programa es el mismo objeto', () => {
  const programas = ap.programasPorDefecto();
  for (const d of Object.values(DETALLES)) assert.equal(ap.aplicarAjustesADetalle(d, programas), d, d.nombre);
});

test('sin publicar, la cotización y los avisos son los de siempre', () => {
  const r: any = buscarCondicionesCarver(LIC_ADM);
  assert.match(r.nota, /reabre en MARZO DE 2027/);
  assert.equal(r.formasDePago.mensualidades.montoCuota, 100);
  const c = consultarProgramas({ texto: 'administración de empresas', tipo: 'licenciatura' }, { limit: 20, verbose: true, wrapOk: true, moreNote: '' }) as any;
  const lic = c.programas.find((p: any) => p.nombre === LIC_ADM);
  assert.match(lic.disponibilidad, /reabre en MARZO DE 2027/);
});

// ── Reglas de Precios ────────────────────────────────────────────────────────────────────────────
const erroresDe = (v: any) => (v.ok ? [] : v.errores) as Array<{ campo: string; mensaje: string }>;

test('precios: las cuotas deben dividir exacto el arancel con beca', () => {
  const v = ap.validarPrecios(preciosCon(PSICO, { cuotas: 7 }));
  const e = erroresDe(v).find((x) => x.campo === `programas.${slugDe(PSICO)}.cuotas`);
  assert.ok(e, 'marca el número de cuotas');
  assert.match(e!.mensaje, /7 cuotas/);
});

test('precios: el contado no puede costar más que el semestral, ni el semestral más que las cuotas', () => {
  const slug = slugDe(PSICO);
  const caro = erroresDe(ap.validarPrecios(preciosCon(PSICO, { contadoTotal: 1500 })));
  assert.ok(caro.some((x) => x.campo === `programas.${slug}.contadoTotal`));
  const semestralCaro = erroresDe(ap.validarPrecios(preciosCon(PSICO, { semestralMonto: 1000 })));
  assert.ok(semestralCaro.some((x) => x.campo === `programas.${slug}.semestralMonto`));
});

test('precios: matrícula regular menor que la con beca, montos vacíos y fecha inválida se rechazan', () => {
  const slug = slugDe(PSICO);
  const e = erroresDe(ap.validarPrecios({ ...preciosCon(PSICO, { matriculaRegular: 10, arancelLista: null }), vigenciaHasta: '2026-02-30' }));
  assert.ok(e.some((x) => x.campo === `programas.${slug}.matriculaRegular`));
  assert.ok(e.some((x) => x.campo === `programas.${slug}.arancelLista`));
  assert.ok(e.some((x) => x.campo === 'vigenciaHasta'));
});

test('precios: un programa que ya no existe se ignora y uno que falta entra con sus valores de siempre', () => {
  const d = ap.preciosPorDefecto();
  const { [slugDe(PSICO)]: _sinPsico, ...resto } = d.programas;
  const v = ap.validarPrecios({ ...d, programas: { ...resto, 'programa-que-ya-no-existe': { arancelLista: 1 } } });
  assert.ok(v.ok);
  assert.equal(Object.keys(v.valor.programas).length, 16);
  assert.deepEqual(v.valor.programas[slugDe(PSICO)], d.programas[slugDe(PSICO)]);
});

// ── Reglas de Programas ──────────────────────────────────────────────────────────────────────────
test('programas: con cupos completos hay que decir cuándo reabre', () => {
  const e = erroresDe(ap.validarProgramas(programasCon(PSICO, { disponibilidad: 'cupos_completos', reabre: '' })));
  assert.ok(e.some((x) => x.campo === `programas.${slugDe(PSICO)}.reabre`));
});

test('programas: el brochure debe ser un enlace https público', () => {
  for (const url of ['http://ejemplo.com/a.pdf', 'https://localhost/a.pdf', 'https://10.0.0.5/a.pdf', 'https://postgres.railway.internal/x', 'no es un enlace']) {
    const e = erroresDe(ap.validarProgramas(programasCon(PSICO, { brochureUrl: url })));
    assert.ok(e.some((x) => x.campo === `programas.${slugDe(PSICO)}.brochureUrl`), url);
  }
  assert.ok(ap.validarProgramas(programasCon(PSICO, { brochureUrl: '' })).ok, 'vacío = sin brochure');
});

test('programas: al abrir la matrícula se olvida la fecha de reapertura', () => {
  const v = ap.validarProgramas(programasCon(LIC_ADM, { disponibilidad: 'abierto' }));
  assert.ok(v.ok);
  assert.equal(v.valor.programas[slugDe(LIC_ADM)].reabre, '');
});

// ── Lo publicado llega al bot ────────────────────────────────────────────────────────────────────
test('un precio publicado cambia la cotización, con arancel con beca y cuota calculados', () => {
  publicar('precios', preciosCon(PSICO, { arancelLista: 4200, cuotas: 12, semestralMonto: 700, contadoTotal: 1000 }));
  const r: any = buscarCondicionesCarver(PSICO);
  assert.equal(r.arancelLista, 4200);
  assert.equal(r.beca.arancel, 2100);
  assert.equal(r.formasDePago.mensualidades.montoCuota, 175);
  assert.equal(r.formasDePago.semestral.montoPago, 700);
  assert.equal(r.formasDePago.contado.total, 1000);
});

test('un monto nuevo sin enlace de PayPal pasa a Flywire; uno con enlace sigue en PayPal', () => {
  publicar('precios', preciosCon(PSICO, { arancelLista: 4200 }));
  const cuota = enlaceDePago(PSICO, 'cuota_mensual');
  assert.ok(cuota.ok);
  assert.equal(cuota.montoUsd, 175);
  assert.equal(cuota.medio, 'flywire', 'no existe un enlace de PayPal por USD 175');
  const matricula = enlaceDePago(PSICO, 'matricula');
  assert.ok(matricula.ok);
  assert.equal(matricula.medio, 'paypal', 'la matrícula sigue en USD 50');
});

test('cupos completos publicados: el bot avisa la reapertura que se escribió en el panel', () => {
  publicar('programas', programasCon(PSICO, { disponibilidad: 'cupos_completos', reabre: 'agosto de 2027' }));
  assert.equal(matchProgramaCarver(PSICO)[0].cotizable, false);
  const r: any = buscarCondicionesCarver(PSICO);
  assert.match(r.nota, /reabre en AGOSTO DE 2027/);
  const c = consultarProgramas({ texto: 'psicología', tipo: 'maestria' }, { limit: 20, verbose: true, wrapOk: true, moreNote: '' }) as any;
  const p = c.programas.find((x: any) => x.nombre === PSICO);
  assert.equal(p.disponible, false);
  assert.match(p.disponibilidad, /reabre en AGOSTO DE 2027/);
});

test('abrir la matrícula desde el panel vuelve cotizable un programa con cupos completos', () => {
  publicar('programas', programasCon(LIC_ADM, { disponibilidad: 'abierto' }));
  const r: any = buscarCondicionesCarver(LIC_ADM);
  assert.doesNotMatch(r.nota, /NO DISPONIBLE/);
});

test('modalidad y duración publicadas llegan al detalle del programa', () => {
  publicar('programas', programasCon(PSICO, { modalidad: '100% en línea, con clases en vivo los sábados.', duracion: '14 meses' }));
  const r: any = detallePrograma({ nombre: PSICO }, 'full');
  assert.equal(r.detalle.modalidad, '100% en línea, con clases en vivo los sábados.');
  assert.equal(r.detalle.duracion, '14 meses');
});

test('el brochure publicado es el que el bot verifica y entrega', async () => {
  _limpiarCacheBrochures();
  publicar('programas', programasCon(PSICO, { brochureUrl: 'https://ejemplo.org/brochure-psicologia.pdf' }));
  const pedidos: string[] = [];
  const fetchFalso = (async (url: string) => {
    pedidos.push(url);
    return new Response(Buffer.from('%PDF-1.7 contenido'), { status: 200, headers: { 'content-type': 'application/pdf' } });
  }) as unknown as typeof fetch;
  const r = await obtenerBrochure({ programa: PSICO }, fetchFalso);
  assert.ok(r.ok);
  assert.equal(r.url, 'https://ejemplo.org/brochure-psicologia.pdf');
  assert.deepEqual(pedidos, ['https://ejemplo.org/brochure-psicologia.pdf']);
});

test('sin brochure publicado, el bot no entrega ningún enlace', async () => {
  publicar('programas', programasCon(PSICO, { brochureUrl: '' }));
  const r = await obtenerBrochure({ programa: PSICO }, (async () => {
    throw new Error('no debería consultar nada');
  }) as unknown as typeof fetch);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.motivo, 'sin_brochure');
});

test('la vigencia publicada manda sobre la de Railway', () => {
  publicar('precios', { ...ap.preciosPorDefecto(), vigenciaHasta: '2026-01-31' });
  const v = estadoVigencia(new Date('2026-03-01T12:00:00Z'));
  assert.equal(v.vigente, false);
  assert.equal(v.hasta, '2026-01-31');
});
