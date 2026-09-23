import { test } from 'node:test';
import assert from 'node:assert/strict';

// Contraparte de marcaCarver.test.ts: sin MARCA definida, TODO debe seguir igual que antes de que
// existiera marca.ts — es el bot que está en marcha blanca, así que esto es una red de seguridad
// contra que un cambio de marca se filtre a Postgrados.
delete process.env.MARCA;
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

const { marca } = await import('../src/marca');
const { PROGRAMAS } = await import('../src/ai/catalog');
const { SYSTEM_PROMPT } = await import('../src/ai/prompt');
const { WHATSAPP_PROFILE } = await import('../src/core/channel');

test('sin MARCA: la marca por defecto es Postgrados', () => {
  assert.equal(marca.key, 'postgrados');
  assert.equal(marca.botNombre, 'Sofía');
  assert.equal(marca.botCargo, 'Asesora de Admisión de Postgrados');
});

test('sin MARCA: el prompt conserva textualmente la identidad y la oferta de siempre', () => {
  assert.ok(
    SYSTEM_PROMPT.startsWith('Eres Sofía, asesora comercial de la Universidad Autónoma de Chile (unidad de Postgrados).'),
    'la primera frase del prompt no puede cambiar',
  );
  assert.match(SYSTEM_PROMPT, /~47 magísteres, ~128 diplomados y 9 especialidades/);
  assert.match(SYSTEM_PROMPT, /consultar_condiciones_comerciales/);
});

test('sin MARCA: el catálogo sigue siendo el de Postgrados', () => {
  assert.ok(PROGRAMAS.length > 150, `esperaba el catálogo completo, hay ${PROGRAMAS.length}`);
  assert.ok(PROGRAMAS.some((p) => p.tipo === 'magister'));
  assert.ok(PROGRAMAS.some((p) => p.tipo === 'diplomado'));
  assert.ok(PROGRAMAS.some((p) => p.tipo === 'especialidad'));
});

test('sin MARCA: WhatsApp mantiene sus 7 herramientas, incluida la de precios', () => {
  assert.deepEqual(WHATSAPP_PROFILE.toolNames, [
    'consultar_programas',
    'detalle_programa',
    'consultar_condiciones_comerciales',
    'registrar_interes_crm',
    'registrar_documento_identidad',
    'solicitar_llamada',
    'escalar_a_humano',
  ]);
});
