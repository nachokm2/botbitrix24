import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Cada evento de Bitrix llega con el token del usuario que lo disparó. Cuando un ASESOR escribe en
// un chat, llega el suyo — y si no tiene concedida la aplicación local, ese token no sirve para
// imbot.message.add. Guardarlo rompía todo lo proactivo: los recordatorios de seguimiento salían
// con él y Bitrix los rechazaba con "user_access_error", mientras las respuestas en vivo seguían
// bien porque usan el token del propio evento. Caso real en Carver: 11 recordatorios perdidos.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

const kv = new Map<string, any>();
mock.module('../src/store/kv.ts', {
  namedExports: {
    getJson: async (k: string) => kv.get(k) ?? null,
    getJsonOrThrow: async (k: string) => kv.get(k) ?? null, // igual que getJson: este test no simula fallo de backend
    setJson: async (k: string, v: unknown) => {
      kv.set(k, JSON.parse(JSON.stringify(v)));
    },
    kvDel: async (k: string) => {
      kv.delete(k);
    },
    once: async () => true,
    getRedisClient: () => null,
    kvKind: () => 'memoria',
  },
});

mock.module('../src/store/tokenCrypto.ts', {
  namedExports: { encryptToken: (t?: string) => t, decryptToken: (t?: string) => t },
});

const { setAuth, getState, marcarSinAcceso } = await import('../src/store');

const auth = (user_id: number, token = `tok-${user_id}`) => ({ domain: 'x.bitrix24.com', access_token: token, user_id });

test('un token nuevo se guarda', async () => {
  kv.clear();
  await setAuth(auth(1));
  assert.equal((await getState()).auth?.user_id, 1);
});

test('tras marcar a un usuario sin acceso, su token deja de guardarse', async () => {
  kv.clear();
  await setAuth(auth(1));
  await marcarSinAcceso(1);
  // El asesor vuelve a escribir en el chat: llega otra vez su token.
  await setAuth(auth(1, 'tok-nuevo'));
  assert.equal((await getState()).auth, undefined, 'no se guarda el token de quien no tiene acceso');
});

test('marcar sin acceso descarta el token guardado de ese usuario', async () => {
  kv.clear();
  await setAuth(auth(7));
  assert.ok((await getState()).auth);
  await marcarSinAcceso(7);
  assert.equal((await getState()).auth, undefined, 'si no sirve, no debe quedar guardado');
});

test('se recupera solo: el token de alguien con acceso sí entra', async () => {
  kv.clear();
  await setAuth(auth(1));
  await marcarSinAcceso(1);
  await setAuth(auth(99, 'tok-bueno'));
  const st = await getState();
  assert.equal(st.auth?.user_id, 99);
  assert.equal(st.auth?.access_token, 'tok-bueno');
});

test('no afecta al token de otro usuario que sí funciona', async () => {
  kv.clear();
  await setAuth(auth(99, 'tok-bueno'));
  await marcarSinAcceso(1); // otro usuario falla
  assert.equal((await getState()).auth?.access_token, 'tok-bueno', 'el bueno se conserva');
});

test('un auth sin user_id sigue guardándose: no todos los orígenes lo traen', async () => {
  // La instalación del app no manda user_id, y ese token es justamente el bueno.
  kv.clear();
  await setAuth({ domain: 'x.bitrix24.com', access_token: 'de-la-instalacion' });
  assert.equal((await getState()).auth?.access_token, 'de-la-instalacion');
});

test('la lista de usuarios sin acceso no crece sin límite', async () => {
  kv.clear();
  for (let i = 1; i <= 70; i++) await marcarSinAcceso(i);
  const guardado = kv.get('app:state');
  assert.ok(guardado.usuariosSinAcceso.length <= 50);
});
