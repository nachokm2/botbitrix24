import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Punto de entrada único: todas las derivaciones caen en una misma persona (Ignacio Ribera, 1313 en
// Carver), que después distribuye. Cubre además un vacío real: sin programas piloto configurados,
// asignarAsesorPorTurno devuelve false y las derivaciones POR SILENCIO no llegaban a NADIE — el
// barrido las descartaba sin asignar ni auditar.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.BITRIX_DERIVAR_A = '1313';

const llamadas: { method: string; params: any }[] = [];
let responsableActual = 777;
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: async (method: string, params: any) => {
      llamadas.push({ method, params });
      return {};
    },
    callCrm: async (method: string, params: any) => {
      llamadas.push({ method, params });
      if (method === 'crm.deal.get') return { ASSIGNED_BY_ID: String(responsableActual) };
      if (method === 'crm.deal.list') return [{ ID: '4242' }];
      return {};
    },
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: [], total: 0, next: null }),
    callWebhook: async () => ({}),
  },
});

const { derivarAResponsableFijo } = await import('../src/crm/asignacionAsesores');
const auth = { domain: 'test.bitrix24.com', access_token: 'tok' } as any;

test('derivarAResponsableFijo: asigna la negociación al responsable configurado', async () => {
  llamadas.length = 0;
  responsableActual = 777;

  const ok = await derivarAResponsableFijo({ deal: 500 }, auth);

  assert.equal(ok, true);
  const update = llamadas.find((c) => c.method === 'crm.deal.update');
  assert.ok(update, 'debe actualizar el responsable de la negociación');
  assert.equal(update!.params.id, 500);
  assert.equal(update!.params.fields.ASSIGNED_BY_ID, 1313);
});

test('derivarAResponsableFijo: si la negociación YA es suya, no la vuelve a escribir', async () => {
  llamadas.length = 0;
  responsableActual = 1313;

  const ok = await derivarAResponsableFijo({ deal: 501 }, auth);

  assert.equal(ok, true, 'igual cuenta como derivada');
  assert.ok(!llamadas.some((c) => c.method === 'crm.deal.update'), 'escribir de nuevo lo mismo es ruido en el timeline');
});

// La mitad de los chats entran vinculados solo a un CONTACTO, sin negociación: sin buscarla, esas
// derivaciones se perderían.
test('derivarAResponsableFijo: sin negociación en el chat, la busca por el contacto', async () => {
  llamadas.length = 0;
  responsableActual = 777;

  const ok = await derivarAResponsableFijo({ contact: 9001 }, auth);

  assert.equal(ok, true);
  const update = llamadas.find((c) => c.method === 'crm.deal.update');
  assert.equal(update!.params.id, 4242, 'la negociación que encontró por el contacto');
});

test('derivarAResponsableFijo: sin negociación ni contacto, no inventa a quién asignar', async () => {
  llamadas.length = 0;
  assert.equal(await derivarAResponsableFijo({}, auth), false);
  assert.ok(!llamadas.some((c) => c.method === 'crm.deal.update'));
});
