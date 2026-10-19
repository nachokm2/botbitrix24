import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Mover la negociación a la etapa "Derivados Bot" al derivarla, para que se vea en el propio embudo
// que el bot ya pasó por ahí. La etapa es por embudo: C73:UC_9HGHNN existe en Carver (73) y no en
// Carver CU (135), y Bitrix rechaza una etapa que no sea del embudo de la negociación.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

let deal: any = { CATEGORY_ID: '73', STAGE_ID: 'C73:NEW', CLOSED: 'N' };
let fallar = false;
const llamadas: any[] = [];
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callCrm: async (method: string, params: any) => {
      llamadas.push({ method, params });
      if (fallar) throw new Error('expired token');
      return method === 'crm.deal.get' ? deal : {};
    },
    callBitrix: async () => ({}),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: {} }),
    callWebhook: async () => ({}),
  },
});

const { moverAEtapaDerivado } = await import('../src/crm/embudos');
const { config } = await import('../src/config');
const auth = { domain: 'test.bitrix24.com', access_token: 'tok' } as any;

const movida = () => llamadas.find((c) => c.method === 'crm.deal.update');

function reset() {
  llamadas.length = 0;
  fallar = false;
  deal = { CATEGORY_ID: '73', STAGE_ID: 'C73:NEW', CLOSED: 'N' };
  config.stageDerivado = { 73: 'C73:UC_9HGHNN' };
  // El default poblado solo existe con MARCA=carver; aquí se fija a mano (mismo conjunto que config.ts).
  config.stageProtegidasDerivacion = [
    'C73:EXECUTING', 'C73:FINAL_INVOICE', 'C73:UC_T3SAID', 'C73:UC_6VN64I', 'C73:UC_8Y04DB', 'C73:UC_6H038F', 'C73:UC_K8O282',
    'C135:1', 'C135:2', 'C135:3', 'C135:4', 'C135:5', 'C135:6', 'C135:7',
  ];
}

test('mueve la negociación del embudo configurado', async () => {
  reset();
  assert.equal(await moverAEtapaDerivado(500, auth), true);
  assert.equal(movida()!.params.fields.STAGE_ID, 'C73:UC_9HGHNN');
});

test('un embudo sin etapa configurada no se toca', async () => {
  reset();
  deal = { CATEGORY_ID: '135', STAGE_ID: 'C135:NEW', CLOSED: 'N' };
  assert.equal(await moverAEtapaDerivado(501, auth), false);
  assert.equal(movida(), undefined, 'Bitrix rechazaría una etapa de otro embudo');
});

test('no reescribe si ya está en esa etapa', async () => {
  reset();
  deal = { CATEGORY_ID: '73', STAGE_ID: 'C73:UC_9HGHNN', CLOSED: 'N' };
  assert.equal(await moverAEtapaDerivado(502, auth), false);
  assert.equal(movida(), undefined, 'reescribirlo solo ensucia el historial');
});

test('no toca una negociación ganada: borraría el desenlace', async () => {
  reset();
  deal = { CATEGORY_ID: '73', STAGE_ID: 'C73:WON', CLOSED: 'Y' };
  assert.equal(await moverAEtapaDerivado(503, auth), false);
  assert.equal(movida(), undefined);
});

test('tampoco una perdida', async () => {
  reset();
  deal = { CATEGORY_ID: '73', STAGE_ID: 'C73:LOSE', CLOSED: 'Y' };
  assert.equal(await moverAEtapaDerivado(504, auth), false);
});

test('no toca una negociación en una etapa protegida de matrícula (Pendiente de Firma, 73)', async () => {
  reset();
  deal = { CATEGORY_ID: '73', STAGE_ID: 'C73:EXECUTING', CLOSED: 'N' }; // Pendiente de Firma
  assert.equal(await moverAEtapaDerivado(507, auth), false);
  assert.equal(movida(), undefined, 'devolverla a Derivados Bot borraría el avance del asesor');
});

test('protege también Pagado (73) y Pendiente de Pago del embudo 135', async () => {
  reset();
  deal = { CATEGORY_ID: '73', STAGE_ID: 'C73:UC_8Y04DB', CLOSED: 'N' }; // Pagado
  assert.equal(await moverAEtapaDerivado(508, auth), false);
  reset();
  config.stageDerivado = { 135: 'C135:UC_9HGHNN' };
  deal = { CATEGORY_ID: '135', STAGE_ID: 'C135:2', CLOSED: 'N' }; // Pendiente de Pago (135)
  assert.equal(await moverAEtapaDerivado(509, auth), false);
  assert.equal(movida(), undefined);
});

test('una etapa NO protegida (Contactando) sí se mueve', async () => {
  reset();
  deal = { CATEGORY_ID: '73', STAGE_ID: 'C73:UC_KY8NN7', CLOSED: 'N' }; // Contactando
  assert.equal(await moverAEtapaDerivado(510, auth), true);
  assert.equal(movida()!.params.fields.STAGE_ID, 'C73:UC_9HGHNN');
});

test('sin configuración no consulta siquiera a Bitrix', async () => {
  reset();
  config.stageDerivado = {};
  assert.equal(await moverAEtapaDerivado(505, auth), false);
  assert.equal(llamadas.length, 0);
});

test('si Bitrix falla, la derivación no se cae por esto', async () => {
  reset();
  fallar = true;
  assert.equal(await moverAEtapaDerivado(506, auth), false);
  config.stageDerivado = {};
});
