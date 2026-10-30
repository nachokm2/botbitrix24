import { test } from 'node:test';
import assert from 'node:assert/strict';

// Cuando Bitrix bloquea el webhook por sobrecarga (OVERLOAD_LIMIT), el bot deja de llamarlo un rato.
// El 30-10-2026 el panel de Carver siguió mandando ~3.000 consultas por hora durante el bloqueo, y
// como los dos bots comparten el webhook, Postgrados también se quedó sin CRM por horas.
process.env.REDIS_URL = '';
process.env.NODE_ENV = 'test';

const { config } = await import('../src/config');
const { callCrm, _reanudarWebhook } = await import('../src/bitrix/client');
config.bitrixWebhookUrl = 'https://ejemplo.bitrix24.es/rest/1/clave';
const auth = { domain: '', access_token: '' } as any;

let pedidos = 0;
let respuesta: any = {};
const fetchOriginal = globalThis.fetch;
globalThis.fetch = (async () => {
  pedidos++;
  return new Response(JSON.stringify(respuesta), { status: 200, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;

test('tras un OVERLOAD_LIMIT, las llamadas siguientes fallan sin llegar a Bitrix', async () => {
  _reanudarWebhook();
  pedidos = 0;
  respuesta = { error: 'OVERLOAD_LIMIT', error_description: 'REST API is blocked due to overload.' };
  await assert.rejects(callCrm('user.get', { ID: 1 }, auth), /OVERLOAD_LIMIT/);
  assert.equal(pedidos, 1);

  // Aunque Bitrix ya respondiera bien, durante la pausa no se le pregunta: el error conserva el
  // código para que quien llama lo trate igual que el bloqueo real.
  respuesta = { result: [{ ID: '2', NAME: 'Ana' }] };
  await assert.rejects(callCrm('user.get', { ID: 2 }, auth), /OVERLOAD_LIMIT/);
  await assert.rejects(callCrm('crm.deal.list', {}, auth), /OVERLOAD_LIMIT/);
  assert.equal(pedidos, 1, 'ninguna consulta salió durante la pausa');

  _reanudarWebhook();
  assert.deepEqual(await callCrm('user.get', { ID: 2 }, auth), [{ ID: '2', NAME: 'Ana' }]);
  assert.equal(pedidos, 2);
});

test('otros errores de Bitrix no pausan el webhook', async () => {
  _reanudarWebhook();
  pedidos = 0;
  respuesta = { error: 'ACCESS_DENIED', error_description: 'Access denied' };
  await assert.rejects(callCrm('crm.deal.get', { id: 1 }, auth), /ACCESS_DENIED/);
  respuesta = { result: { ID: '1' } };
  assert.deepEqual(await callCrm('crm.deal.get', { id: 1 }, auth), { ID: '1' });
  assert.equal(pedidos, 2);
  globalThis.fetch = fetchOriginal;
});
