import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// esEmpleadoBitrix: distingue un EMPLEADO real del portal (asesor/operador) de un participante
// externo de Open Lines (cliente por WhatsApp/IG/etc., que tiene un ID numérico pero NO existe como
// usuario del portal). Bug real que motivó esto: en botEvents.ts, el primer mensaje de un chat
// reactivado venía del asesor asignado (no del cliente) y se fijaba como "clientId" — los mensajes
// reales del cliente después quedaban mal clasificados como "un operador escribió" y el bot se
// callaba para siempre en esa conversación (ver deal #3490143).
process.env.REDIS_URL = '';
process.env.NODE_ENV = 'test';

let responder: (method: string, params: any) => any = () => ({});
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: async (m: string, p: any) => responder(m, p),
    callCrm: async (m: string, p: any) => responder(m, p),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: {} }),
    callWebhook: async () => ({}),
  },
});

const { esEmpleadoBitrix } = await import('../src/crm/directory');
const auth = { domain: '', access_token: '' } as any;

test('esEmpleadoBitrix: user.get devuelve un registro real (NAME/EMAIL) → true', async () => {
  responder = (method) => (method === 'user.get' ? { NAME: 'Asesor', LAST_NAME: 'Uno', EMAIL: 'a@x.cl' } : {});
  assert.equal(await esEmpleadoBitrix(4173, auth), true);
});

test('esEmpleadoBitrix: user.get vacío (participante externo de Open Lines) → false', async () => {
  responder = (method) => (method === 'user.get' ? {} : {});
  assert.equal(await esEmpleadoBitrix(759815, auth), false);
});

test('esEmpleadoBitrix: user.get falla (error/scope) → false (fail-open: se trata como cliente)', async () => {
  responder = () => {
    throw new Error('boom');
  };
  assert.equal(await esEmpleadoBitrix(123, auth), false);
});

test('esEmpleadoBitrix: id inválido (0 o no numérico) → false sin llamar a Bitrix', async () => {
  let called = false;
  responder = () => {
    called = true;
    return {};
  };
  assert.equal(await esEmpleadoBitrix(0, auth), false);
  assert.equal(called, false, 'no llama a user.get con un id inválido');
});
