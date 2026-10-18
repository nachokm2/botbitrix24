import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';

// /install no exige autenticación (la llama Bitrix al instalar). Antes guardaba las credenciales de
// CUALQUIER dominio que llegara en el cuerpo y le hacía peticiones a ese dominio —incluido
// placement.bind con el DASHBOARD_TOKEN en la URL—, y sin BITRIX_APPLICATION_TOKEN (Carver)
// reemplazaba el token que verifica los eventos. Ahora solo acepta el portal propio y un token que
// funcione en él, y no guarda ni llama nada antes de comprobarlo.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.BASE_URL = 'https://bot.ejemplo.invalid';
process.env.DASHBOARD_TOKEN = 'TOKEN-PANEL-DE-PRUEBA';
process.env.BITRIX_WEBHOOK_URL = 'https://portal.bitrix24.es/rest/1/x/';

const llamadas: { metodo: string; dominio: string }[] = [];
let tokenValido = true;
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: async (metodo: string, _p: unknown, auth: { domain: string }) => {
      llamadas.push({ metodo, dominio: auth.domain });
      if (metodo === 'app.info' && !tokenValido) throw new Error('Bitrix app.info: invalid_token');
      return metodo === 'imbot.register' ? 4242 : true;
    },
  },
});

const { installHandler } = await import('../src/routes/install');
const { getState } = await import('../src/store');
const { setJson } = await import('../src/store/kv');
const { config } = await import('../src/config');

function respuesta() {
  const res: any = { statusCode: 200, cuerpo: '' };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.send = (b: string) => ((res.cuerpo = b), res);
  return res as Response & { statusCode: number; cuerpo: string };
}

async function instalar(body: Record<string, unknown>) {
  const res = respuesta();
  await installHandler({ body, query: {}, path: '/install' } as unknown as Request, res);
  return res;
}

async function limpio() {
  llamadas.length = 0;
  tokenValido = true;
  await setJson('app:state', {});
}

const evento = (dominio: string, appToken = 'token-de-la-app') => ({
  AUTH_ID: 'access-token',
  REFRESH_ID: 'refresh-token',
  DOMAIN: dominio,
  application_token: appToken,
});

test('el portal se deduce del webhook', () => {
  assert.equal(config.bitrixPortalDomain, 'portal.bitrix24.es');
});

test('un dominio ajeno se rechaza sin guardar nada ni llamar a nadie', async () => {
  await limpio();
  const res = await instalar(evento('atacante.example', 'token-del-atacante'));
  assert.equal(res.statusCode, 403);
  assert.deepEqual(llamadas, [], 'ninguna petición, y menos a un dominio ajeno');
  const st = await getState();
  assert.equal(st.auth, undefined);
  assert.equal(st.appToken, undefined);
});

test('el portal propio con un token que no funciona se rechaza antes de guardar', async () => {
  await limpio();
  tokenValido = false;
  const res = await instalar(evento('portal.bitrix24.es'));
  assert.equal(res.statusCode, 401);
  assert.deepEqual(llamadas.map((l) => l.metodo), ['app.info'], 'solo la verificación del token');
  const st = await getState();
  assert.equal(st.auth, undefined);
  assert.equal(st.appToken, undefined);
});

test('la instalación legítima sigue funcionando y todo va al portal propio', async () => {
  await limpio();
  const res = await instalar(evento('Portal.Bitrix24.es'));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(llamadas.map((l) => l.metodo), ['app.info', 'imbot.register', 'placement.bind']);
  assert.ok(llamadas.every((l) => l.dominio.toLowerCase() === 'portal.bitrix24.es'));
  const st = await getState();
  assert.equal(st.auth?.domain.toLowerCase(), 'portal.bitrix24.es');
  assert.equal(st.appToken, 'token-de-la-app');
  assert.equal(st.botId, 4242);
});

test('con BITRIX_APPLICATION_TOKEN configurado, un token distinto se sigue rechazando', async () => {
  await limpio();
  const antes = config.bitrixAppToken;
  config.bitrixAppToken = 'token-de-la-variable';
  try {
    const res = await instalar(evento('portal.bitrix24.es', 'otro-token'));
    assert.equal(res.statusCode, 401);
    assert.equal((await getState()).appToken, undefined);
  } finally {
    config.bitrixAppToken = antes;
  }
});

test('en producción, sin portal configurado, no se instala nada', async () => {
  await limpio();
  const antes = { portal: config.bitrixPortalDomain, env: process.env.NODE_ENV };
  config.bitrixPortalDomain = '';
  process.env.NODE_ENV = 'production';
  try {
    const res = await instalar(evento('portal.bitrix24.es'));
    assert.equal(res.statusCode, 503);
    assert.deepEqual(llamadas, []);
  } finally {
    config.bitrixPortalDomain = antes.portal;
    process.env.NODE_ENV = antes.env;
  }
});

test('un application_token que no es texto no tumba la instalación ni se guarda', async () => {
  await limpio();
  const res = await instalar({ ...evento('portal.bitrix24.es'), application_token: { toString: '1' } });
  assert.equal(res.statusCode, 200);
  assert.equal((await getState()).appToken, undefined);
});
