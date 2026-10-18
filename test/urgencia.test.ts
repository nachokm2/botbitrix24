import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Distintivo de urgencia para lo que el bot escala por PUNTAJE. Ese escalamiento es el que más vale
// atender rápido —lo dispara una conversación con interés claro y datos ya entregados— pero en el
// embudo se ve igual que cualquier otra negociación.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

let deal: any = { TITLE: 'Maestría en Psicología – Ana' };
let fallar = false;
const llamadas: any[] = [];
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callCrm: async (method: string, params: any) => {
      llamadas.push({ method, params });
      if (fallar) throw new Error('expired token');
      return method === 'crm.deal.get' ? deal : {};
    },
    callBitrix: async () => ({}),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: {} }),
    callWebhook: async () => ({}),
  },
});

const claves = new Map<string, string>();
mock.module('../src/store/kv.ts', {
  namedExports: {
    getRedisClient: () => ({
      get: async (k: string) => claves.get(k) ?? null,
      set: async (k: string, v: string) => {
        claves.set(k, v);
        return 'OK';
      },
      hincrby: async () => 1,
    }),
    getJson: async () => null,
    getJsonOrThrow: async () => null,
    setJson: async () => {},
    kvDel: async () => {},
    once: async () => true,
  },
});

mock.module('../src/obs/audit.ts', { namedExports: { audit: async () => {} } });

const { marcarUrgente, esUrgente, conMarcaUrgente, sinMarcaUrgente } = await import('../src/crm/urgencia');
const { config } = await import('../src/config');
const auth = { domain: 'test.bitrix24.com', access_token: 'tok' } as any;

const update = () => llamadas.find((c) => c.method === 'crm.deal.update');

function reset() {
  llamadas.length = 0;
  claves.clear();
  fallar = false;
  deal = { TITLE: 'Maestría en Psicología – Ana' };
  config.marcaUrgente = '🔥 URGENTE · ';
}

test('antepone el distintivo al título', async () => {
  reset();
  assert.equal(await marcarUrgente(500, auth, { score: 85 }), true);
  assert.equal(update()!.params.fields.TITLE, '🔥 URGENTE · Maestría en Psicología – Ana');
  assert.equal(await esUrgente(500), true);
});

test('no duplica el distintivo si ya estaba', async () => {
  reset();
  deal = { TITLE: '🔥 URGENTE · Maestría en Psicología – Ana' };
  assert.equal(await marcarUrgente(501, auth), false);
  assert.equal(update(), undefined, 'reescribir lo mismo solo ensucia el historial');
});

test('la marca sobrevive al recomponer el título', async () => {
  // El bot reescribe el título cada vez que cambia el programa de interés: sin esto, la urgencia se
  // borraba sola justo cuando la conversación iba bien.
  reset();
  assert.equal(conMarcaUrgente('Licenciatura – Ana'), '🔥 URGENTE · Licenciatura – Ana');
  assert.equal(conMarcaUrgente('🔥 URGENTE · Licenciatura – Ana'), '🔥 URGENTE · Licenciatura – Ana');
  assert.equal(sinMarcaUrgente('🔥 URGENTE · Licenciatura – Ana'), 'Licenciatura – Ana');
});

test('sin distintivo configurado no marca nada', async () => {
  reset();
  config.marcaUrgente = '';
  assert.equal(await marcarUrgente(502, auth), false);
  assert.equal(llamadas.length, 0);
  assert.equal(await esUrgente(502), false);
  config.marcaUrgente = '🔥 URGENTE · ';
});

test('sin negociación no hay nada que marcar', async () => {
  reset();
  assert.equal(await marcarUrgente(undefined, auth), false);
});

test('si Bitrix falla, la derivación no se cae por el distintivo', async () => {
  reset();
  fallar = true;
  assert.equal(await marcarUrgente(503, auth), false, 'avisar al asesor importa más que el adorno');
});

test('una negociación sin marcar no se reporta como urgente', async () => {
  reset();
  assert.equal(await esUrgente(999), false);
});
