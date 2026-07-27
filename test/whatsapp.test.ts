import { test } from 'node:test';
import assert from 'node:assert/strict';

// Fase 5: construcción del payload de Meta Cloud API (puro) + skip cuando no hay proveedor configurado.
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';
process.env.WA_PROVIDER = ''; // desactivado → enviarPlantillaWhatsApp debe hacer skip sin red

const { construirPayloadMeta, enviarPlantillaWhatsApp } = await import('../src/whatsapp/template');

test('construirPayloadMeta: template con parámetro de body', () => {
  const p = construirPayloadMeta('+56912345678', 'seguimiento_mmd', 'es', ['Rodrigo']);
  assert.equal(p.messaging_product, 'whatsapp');
  assert.equal(p.to, '56912345678'); // sin el '+'
  assert.equal(p.type, 'template');
  assert.equal(p.template.name, 'seguimiento_mmd');
  assert.equal(p.template.language.code, 'es');
  assert.deepEqual(p.template.components, [{ type: 'body', parameters: [{ type: 'text', text: 'Rodrigo' }] }]);
});

test('construirPayloadMeta: sin parámetros no incluye components', () => {
  const p = construirPayloadMeta('56911112222', 'aviso', 'es', []);
  assert.equal(p.template.components, undefined);
});

test('enviarPlantillaWhatsApp: sin WA_PROVIDER → skipped (no llama a la red)', async () => {
  const r = await enviarPlantillaWhatsApp({ phoneE164: '+56912345678', template: 't', lang: 'es', params: ['x'] });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, true);
});
