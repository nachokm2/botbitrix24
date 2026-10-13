import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Límite por embudo. Los dos bots comparten portal de Bitrix. Una persona que ya tenía negociación
// en un embudo de Postgrados le escribió al WhatsApp de Carver; Bitrix enlazó el chat a ESA
// negociación y el bot de Carver la renombró con un programa suyo y se la reasignó a su punto de
// entrada único — se la quitó al asesor que la tenía. Caso real: deal#3160607, embudo 83.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

let deal: any = { CATEGORY_ID: '73' };
let falla = false;
const consultas: any[] = [];
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callCrm: async (method: string, params: any) => {
      consultas.push({ method, params });
      if (falla) throw new Error('expired token');
      return deal;
    },
    callBitrix: async () => ({}),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: {} }),
    callWebhook: async () => ({}),
  },
});

const { esEmbudoPropio, filtroEmbudosPropios } = await import('../src/crm/embudos');
const { config } = await import('../src/config');

const auth = { domain: 'test.bitrix24.com', access_token: 'tok' } as any;

function reset(propios: number[]) {
  consultas.length = 0;
  falla = false;
  deal = { CATEGORY_ID: '73' };
  config.embudosPropios = propios;
}

test('sin lista configurada todo es propio: no cambia nada donde no hace falta', async () => {
  reset([]);
  assert.equal(await esEmbudoPropio(999, auth), true);
  assert.equal(consultas.length, 0, 'ni siquiera consulta a Bitrix');
  assert.deepEqual(filtroEmbudosPropios(), {});
});

test('una negociación de un embudo propio se puede tocar', async () => {
  reset([73, 135]);
  deal = { CATEGORY_ID: '73' };
  assert.equal(await esEmbudoPropio(1, auth), true);
});

test('una de otro embudo NO se toca', async () => {
  reset([73, 135]);
  deal = { CATEGORY_ID: '83' }; // Triple Certificación: el caso real
  assert.equal(await esEmbudoPropio(2, auth), false);
});

test('si no se puede comprobar el embudo, se asume ajena', async () => {
  // No tocar lo que no se sabe de quién es. El costo de equivocarse acá es quitarle un lead a otro
  // equipo; el de abstenerse, no actualizar una ficha.
  reset([73]);
  falla = true;
  assert.equal(await esEmbudoPropio(3, auth), false);
});

test('sin negociación no hay nada propio que tocar', async () => {
  reset([73]);
  assert.equal(await esEmbudoPropio(undefined, auth), false);
});

test('cachea para no preguntar el embudo en cada turno', async () => {
  reset([73]);
  deal = { CATEGORY_ID: '73' };
  await esEmbudoPropio(42, auth);
  await esEmbudoPropio(42, auth);
  await esEmbudoPropio(42, auth);
  assert.equal(consultas.length, 1);
});

test('el filtro acota la búsqueda de negociaciones del contacto', () => {
  // Sin este filtro se tomaba la negociación MÁS RECIENTE del contacto, de cualquier embudo.
  reset([73, 135]);
  assert.deepEqual(filtroEmbudosPropios(), { '@CATEGORY_ID': [73, 135] });
  config.embudosPropios = [];
});
