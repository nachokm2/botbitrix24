import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// El panel mostraba "Embudo 73" y agrupaba los embudos de otra marca en una fila que decía "revisar"
// sin decir qué. Con 45 embudos en el portal eso no se puede interpretar: no distingue una
// conversación de Postgrados que se coló —se arregla en el bot— de un embudo de Carver que nadie
// declaró en BITRIX_EMBUDOS_PROPIOS, que se arregla en la configuración.
process.env.MARCA = 'carver';
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

let llamadas = 0;
let respuesta: any = [
  { ID: '73', NAME: 'Carver' },
  { ID: '135', NAME: 'Carver CU' },
  { ID: '89', NAME: 'Cobranza Carver' },
];
let falla = false;

mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callCrm: async (method: string) => {
      assert.equal(method, 'crm.dealcategory.list');
      llamadas++;
      if (falla) throw new Error('expired token');
      return respuesta;
    },
    callBitrix: async () => ({}),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: [] }),
    callWebhook: async () => ({}),
  },
});
mock.module('../src/obs/audit.ts', { namedExports: { audit: async () => {} } });

const { nombresDeEmbudos } = await import('../src/crm/embudosNombres');
const auth = { domain: 'test.bitrix24.com', access_token: 'tok' } as any;

test('devuelve el nombre de cada embudo, y el 0 que Bitrix nunca lista', async () => {
  const n = await nombresDeEmbudos(auth);
  assert.equal(n.get(73), 'Carver');
  assert.equal(n.get(135), 'Carver CU');
  assert.equal(n.get(89), 'Cobranza Carver');
  // El "General" de fábrica no viene en crm.dealcategory.list; sin esto saldría como "Embudo 0".
  assert.equal(n.get(0), 'General');
});

test('se cachea: el panel se recarga seguido y los embudos casi nunca cambian', async () => {
  const antes = llamadas;
  await nombresDeEmbudos(auth);
  await nombresDeEmbudos(auth);
  assert.equal(llamadas, antes, 'no vuelve a preguntarle a Bitrix');
});

test('si Bitrix falla, un nombre viejo es mejor que ninguno', async () => {
  // Un panel sin nombres sigue siendo legible (cae a "Embudo N"); uno que revienta, no. Y los
  // nombres vencidos siguen siendo correctos: un embudo no se renombra entre dos cargas del panel.
  process.env.EMBUDOS_NOMBRES_TTL_MS = '0'; // vence el caché para llegar de verdad al camino de error
  falla = true;
  const antes = llamadas;
  const n = await nombresDeEmbudos(auth);
  assert.equal(llamadas, antes + 1, 'lo intentó: no se quedó en el caché');
  assert.equal(n.get(73), 'Carver', 'devuelve lo que ya tenía en vez de propagar el error');
  delete process.env.EMBUDOS_NOMBRES_TTL_MS;
});
