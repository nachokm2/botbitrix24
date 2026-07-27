import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buscarCondiciones, CONDICIONES_GLOBALES, esProgramaNoOfertable } from '../src/core/condicionesComerciales';
import { consultarProgramas } from '../src/core/catalogTool';

// La capa de datos comercial: cotiza con el DESCUENTO real (no el arancel de lista), desambigua por sede,
// filtra por estado y expone las reglas globales (Toku, formulario de soporte). Datos: condicionesComerciales.data.json.

test('entrega el precio de LISTA por defecto; el descuento va en un bloque aparte', () => {
  const r: any = buscarCondiciones('Magíster en Marketing Digital');
  assert.equal(r.cotizable, true);
  assert.equal(r.arancel, '$4.990.000', 'arancel de lista por defecto (no el con descuento)');
  assert.equal(r.total, '$5.240.000', 'total de lista = arancel lista + matrícula');
  assert.equal(r.descuento.pct, 30);
  assert.equal(r.descuento.arancelConDescuento, '$3.493.000');
  assert.equal(r.descuento.total, '$3.743.000');
  assert.equal(r.pago.cuotas.n, 24, 'Magíster: hasta 24 cuotas');
  assert.equal(r.pago.sinLinkDirecto, true, 'no envía link de pago (Toku es batch)');
});

test('el nombre del catálogo (prefijo "Magíster en") casa con la tabla ("Marketing Digital")', () => {
  const conPrefijo: any = buscarCondiciones('Magíster en Marketing Digital');
  const sinPrefijo: any = buscarCondiciones('Marketing Digital');
  assert.equal(conPrefijo.codigo, 'MAG-MAR-175');
  assert.equal(sinPrefijo.codigo, 'MAG-MAR-175');
});

test('programa masivo/beca (arancel liberado 100%) → NO cotizable (no habilitado para venta)', () => {
  const r: any = buscarCondiciones('Procesos de Formulación y Planificación Estratégica');
  assert.equal(r.cotizable, false);
  assert.equal(r.motivo, 'masivo_no_habilitado');
});

test('excepción DI-DAT-024 (masivo con 30%, no beca) sí cotiza como venta normal', () => {
  const r: any = buscarCondiciones('Data Science para Organizaciones de Salud');
  assert.equal(r.cotizable, true);
  assert.equal(r.arancel, '$1.290.000', 'lista por defecto');
  assert.equal(r.descuento.pct, 30);
  assert.equal(r.descuento.total, '$1.053.000');
});

test('esProgramaNoOfertable: true para beca/masivo, false para programa normal', () => {
  assert.equal(esProgramaNoOfertable('Diplomado en Big Data and Machine Learning'), true);
  assert.equal(esProgramaNoOfertable('Magíster en Marketing Digital'), false);
});

test('consultar_programas NO propone masivos/becas no habilitados', () => {
  const pres = { limit: 30, verbose: false, wrapOk: false, moreNote: '' };
  const r: any = consultarProgramas({ texto: 'big data machine learning' }, pres);
  const nombres = (r.programas ?? []).map((x: any) => String(x.nombre).toLowerCase());
  assert.ok(
    !nombres.some((n: string) => n.includes('big data and machine learning')),
    'el masivo Big Data queda fuera de las recomendaciones',
  );
});

test('nombre duplicado por sede → ambiguo; con sede resuelve', () => {
  const amb: any = buscarCondiciones('Neurociencias');
  assert.equal(amb.ambiguo, true);
  assert.ok(amb.opciones.length >= 2, 'ofrece las sedes');
  const stgo: any = buscarCondiciones('Neurociencias', 'Santiago');
  assert.equal(stgo.cotizable, true);
  assert.ok(String(stgo.programa).includes('Santiago'));
});

test('programa suspendido → no cotizable con motivo (deriva, no inventa precio)', () => {
  const r: any = buscarCondiciones('Justicia Constitucional y Derechos Humanos');
  assert.equal(r.cotizable, false);
  assert.equal(r.motivo, 'suspendido');
});

test('programa nuevo sin precio confirmado → no cotizable (§8)', () => {
  const r: any = buscarCondiciones('Data Science'); // MAG-DAT-203, nuevo
  assert.equal(r.cotizable, false);
  assert.equal(r.motivo, 'nuevo_sin_precio');
});

test('programa inexistente → no encontrado (deriva a asesor)', () => {
  const r: any = buscarCondiciones('Programa que no existe xyz');
  assert.equal(r.encontrado, false);
});

test('sin programa → reglas generales de financiamiento Toku', () => {
  const r: any = buscarCondiciones();
  assert.equal(r.general, true);
  assert.match(r.financiamiento.medios, /crédito/);
});

test('reglas globales: soporte con SLA 2 días y cuotas Toku confirmadas', () => {
  assert.match(CONDICIONES_GLOBALES.soporte.url, /postgrados\.uautonoma\.cl\/soporte/);
  assert.equal(CONDICIONES_GLOBALES.soporte.sla, '2 días hábiles');
  assert.equal(CONDICIONES_GLOBALES.toku.cuotasPorTipo['Diplomado'], 5);
  assert.equal(CONDICIONES_GLOBALES.toku.cuotasPorTipo['Magíster'], 24);
});
