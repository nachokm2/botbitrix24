import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Ritmo humano: antes de responder, el bot muestra "escribiendo…" y espera un tiempo aleatorio, para no
// parecer un bot que contesta al instante. Con el delay apagado (config por defecto) solo muestra el
// indicador una vez, como antes.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

let typings = 0;
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: async (method: string) => {
      if (method === 'imbot.chat.sendTyping') typings++;
      return {};
    },
    callCrm: async () => ({}),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: [] }),
    callWebhook: async () => ({}),
  },
});

const { delayHumanoMs, esperarComoHumano } = await import('../src/core/ritmoHumano');
const { config } = await import('../src/config');
const auth = { domain: 'x.bitrix24.com', access_token: 'tok' } as any;

// setImmediate NO se mockea (solo setTimeout+Date): drena la cadena async que disparan los timers.
const drenar = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

test('delayHumanoMs: desactivado (max<=0) siempre da 0', () => {
  config.respuestaDelayMinS = 0;
  config.respuestaDelayMaxS = 0;
  for (let i = 0; i < 20; i++) assert.equal(delayHumanoMs(), 0);
});

test('delayHumanoMs: con rango, cae dentro de [min, max] segundos', () => {
  config.respuestaDelayMinS = 1;
  config.respuestaDelayMaxS = 60;
  for (let i = 0; i < 300; i++) {
    const ms = delayHumanoMs();
    assert.ok(ms >= 1000 && ms <= 60000, `fuera de rango: ${ms}`);
  }
  config.respuestaDelayMinS = 0;
  config.respuestaDelayMaxS = 0;
});

test('sin delay: muestra "escribiendo" una sola vez y resuelve de inmediato', async () => {
  config.respuestaDelayMinS = 0;
  config.respuestaDelayMaxS = 0;
  typings = 0;
  await esperarComoHumano(800185, 'chatX', auth);
  assert.equal(typings, 1, 'un solo indicador, sin espera');
});

test('con delay largo: espera ~el tiempo y mantiene vivo el "escribiendo"', async (t) => {
  config.respuestaDelayMinS = 40; // determinista: exactamente 40 s
  config.respuestaDelayMaxS = 40;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  typings = 0;
  let resuelto = false;
  void esperarComoHumano(800185, 'chatY', auth).then(() => {
    resuelto = true;
  });
  await drenar();
  assert.equal(typings, 1, 'muestra "escribiendo" de inmediato');

  t.mock.timers.tick(18_000);
  await drenar();
  t.mock.timers.tick(18_000);
  await drenar();
  t.mock.timers.tick(18_000);
  await drenar();

  assert.equal(resuelto, true, 'resuelve tras ~40 s');
  assert.ok(typings >= 3, `re-emitió el indicador durante la espera (fueron ${typings})`);
  config.respuestaDelayMinS = 0;
  config.respuestaDelayMaxS = 0;
});
