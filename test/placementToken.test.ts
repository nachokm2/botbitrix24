import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// El token del panel debe viajar SOLO a Bitrix (en el HANDLER del placement). Antes quedaba entero en
// los logs de Railway —en cada instalación y en cada /setup/bind-*— y en la respuesta de /setup, y
// con él se leen todas las conversaciones del panel.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.BASE_URL = 'https://bot.ejemplo.invalid';
process.env.DASHBOARD_TOKEN = 'TOKEN-PANEL-DE-PRUEBA';

const enviados: Record<string, unknown>[] = [];
let respuestaBitrix: () => Promise<unknown> = async () => true;
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: async (_metodo: string, params: Record<string, unknown>) => {
      enviados.push(params);
      return respuestaBitrix();
    },
  },
});

const { bindDashboard } = await import('../src/bitrix/placement');

async function capturarLogs(fn: () => Promise<unknown>) {
  const lineas: string[] = [];
  const original = console.log;
  console.log = (...a: unknown[]) => void lineas.push(a.map(String).join(' '));
  try {
    return { resultado: await fn(), lineas };
  } finally {
    console.log = original;
  }
}

const auth = { domain: 'portal.bitrix24.es', access_token: 't' };

test('placement.bind: el token va a Bitrix pero no al log ni a lo devuelto', async () => {
  enviados.length = 0;
  respuestaBitrix = async () => true;
  const { resultado, lineas } = await capturarLogs(() => bindDashboard(auth));
  assert.equal(enviados[0].HANDLER, 'https://bot.ejemplo.invalid/app?k=TOKEN-PANEL-DE-PRUEBA');
  assert.ok(lineas.length > 0, 'deja constancia en el log');
  for (const l of lineas) assert.ok(!l.includes('TOKEN-PANEL-DE-PRUEBA'), `token en el log: ${l}`);
  assert.ok(!JSON.stringify(resultado).includes('TOKEN-PANEL-DE-PRUEBA'));
  assert.equal((resultado as { handler: string }).handler, 'https://bot.ejemplo.invalid/app?k=***');
});

test('placement.bind: tampoco se filtra cuando Bitrix responde con error (ni si el error repite el HANDLER)', async () => {
  respuestaBitrix = async () => {
    throw new Error('Bitrix placement.bind: ERROR_X https://bot.ejemplo.invalid/app?k=TOKEN-PANEL-DE-PRUEBA');
  };
  const { resultado, lineas } = await capturarLogs(() => bindDashboard(auth));
  for (const l of lineas) assert.ok(!l.includes('TOKEN-PANEL-DE-PRUEBA'), `token en el log: ${l}`);
  assert.ok(!JSON.stringify(resultado).includes('TOKEN-PANEL-DE-PRUEBA'));
  assert.equal((resultado as { ok: boolean }).ok, false);
});
