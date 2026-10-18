import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// CONF-01: un fallo transitorio de lectura de Redis no debe borrar el estado del app.
// readState leía {} ante un error de getJson (que lo traga y devuelve null), y los escritores del
// camino caliente (setAuth, marcarSinAcceso, setBotId, setAppToken) reescribían ese {}, borrando el
// application_token —que en Carver vive SOLO en Redis— y el botId. Ahora los escritores leen en modo
// estricto (getJsonOrThrow propaga el error) y abortan sin escribir si la lectura falla.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

let almacen: Record<string, any> = {};
let fallarLectura = false;

mock.module('../src/store/kv.ts', {
  namedExports: {
    getJson: async (k: string) => (fallarLectura ? null : almacen[k] ?? null), // traga el error (fail-open), como el real
    getJsonOrThrow: async (k: string) => {
      if (fallarLectura) throw new Error('Redis caído (simulado)');
      return almacen[k] ?? null;
    },
    setJson: async (k: string, v: unknown) => { almacen[k] = JSON.parse(JSON.stringify(v)); },
    kvDel: async (k: string) => { delete almacen[k]; },
    once: async () => true,
    getRedisClient: () => null,
    kvKind: () => 'memoria',
  },
});
mock.module('../src/store/tokenCrypto.ts', {
  namedExports: { encryptToken: (t?: string) => t, decryptToken: (t?: string) => t },
});

const { setAppToken, setBotId, setAuth, getState } = await import('../src/store');

function sembrar(estado: any) { almacen = { 'app:state': estado }; fallarLectura = false; }

test('con Redis caído, setAppToken NO pisa el estado: se conserva el appToken anterior', async () => {
  sembrar({ appToken: 'token-legitimo', botId: 800185, auth: { domain: 'x', access_token: 'a' } });
  fallarLectura = true;
  await setAppToken('token-nuevo-del-evento');
  fallarLectura = false;
  const s = await getState();
  assert.equal(s.appToken, 'token-legitimo', 'no se sobrescribió');
  assert.equal(s.botId, 800185, 'el botId sigue ahí');
});

test('con Redis caído, setAuth y setBotId tampoco borran nada', async () => {
  sembrar({ appToken: 'token-legitimo', botId: 800185 });
  fallarLectura = true;
  await setAuth({ domain: 'y', access_token: 'b', user_id: 7 });
  await setBotId(999);
  fallarLectura = false;
  const s = await getState();
  assert.equal(s.appToken, 'token-legitimo');
  assert.equal(s.botId, 800185, 'setBotId abortó: no escribió 999 sobre un estado que no pudo leer');
});

test('con Redis sano, los escritores funcionan igual que antes', async () => {
  sembrar({});
  await setAppToken('nuevo');
  await setBotId(800185);
  const s = await getState();
  assert.equal(s.appToken, 'nuevo');
  assert.equal(s.botId, 800185);
});

test('getState (lectura) sigue siendo fail-open: ante error devuelve {} sin lanzar', async () => {
  sembrar({ appToken: 'x' });
  fallarLectura = true;
  const s = await getState();
  assert.deepEqual(s, {}); // no lanza; la verificación de eventos ya es fail-closed por su cuenta
});
