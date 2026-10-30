import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Las rotaciones del DASHBOARD_TOKEN dejaban enlazadas las entradas viejas del menú de Bitrix: aparecían
// dos o tres "Agente X" y las viejas respondían "unauthorized". La limpieza quita solo esas.
process.env.REDIS_URL = '';
process.env.NODE_ENV = 'test';
process.env.BASE_URL = 'https://botcarver-production.up.railway.app';
process.env.DASHBOARD_TOKEN = 'token-vigente';

const llamadas: Array<{ method: string; params: any }> = [];
const BASE = 'https://botcarver-production.up.railway.app';
const enlazados = [
  { placement: 'LEFT_MENU', handler: `${BASE}/app?k=token-viejo`, title: 'Agente Carver' },
  { placement: 'LEFT_MENU', handler: `${BASE}/app?k=token-vigente`, title: 'Agente Carver' },
  { placement: 'LEFT_MENU', handler: `${BASE}/app`, title: 'Agente Carver' },
  { placement: 'LEFT_MENU', handler: `${BASE}/panel`, title: 'Configuración bot Carver' },
  { placement: 'LEFT_MENU', handler: 'https://otra-app.example.com/app?k=x', title: 'Otra app' },
];
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: async (method: string, params: any) => {
      llamadas.push({ method, params });
      return method === 'placement.get' ? enlazados : true;
    },
    callCrm: async () => ({}),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: {} }),
    callWebhook: async () => ({}),
  },
});

const { limpiarPlacementsViejos } = await import('../src/bitrix/placement');

test('quita solo los paneles de este servidor con token viejo o sin token', async () => {
  const r = await limpiarPlacementsViejos({ domain: 'uachile.bitrix24.es', access_token: 'x' } as any);
  assert.deepEqual(r, { quitados: 2, conservados: 1, errores: 0 });
  const quitados = llamadas.filter((c) => c.method === 'placement.unbind').map((c) => c.params.HANDLER);
  assert.deepEqual(quitados, [`${BASE}/app?k=token-viejo`, `${BASE}/app`]);
  assert.ok(!quitados.some((h) => h.includes('/panel')), 'el panel de configuración no se toca');
  assert.ok(!quitados.some((h) => h.includes('otra-app')), 'lo de otro servidor no se toca');
});
