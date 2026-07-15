import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Test de integración de la escritura al CRM (actualizarDatosCliente). Mockea el cliente Bitrix
// (../src/bitrix/client) para capturar los métodos REST invocados y sus payloads, SIN tocar la red.
// Verifica la fusión de multicampos: agregar un email nuevo NO debe borrar el existente.
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

type Call = { method: string; params: any };
const calls: Call[] = [];
let responder: (method: string, params: any) => any = () => ({});

const record = async (method: string, params: any) => {
  calls.push({ method, params });
  return responder(method, params);
};

mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: record,
    callCrm: record,
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: {} }),
    callWebhook: async () => ({}),
  },
});

const { actualizarDatosCliente } = await import('../src/crm/crmWrite');

const auth = { domain: '', access_token: '' } as any;

test('actualizarDatosCliente: fusiona email nuevo sin borrar el existente', async () => {
  calls.length = 0;
  responder = (method) => {
    if (method === 'crm.contact.get') {
      return {
        EMAIL: [{ ID: '10', VALUE: 'antiguo@correo.cl', VALUE_TYPE: 'WORK' }],
        PHONE: [{ ID: '20', VALUE: '+56911112222', VALUE_TYPE: 'MOBILE' }],
      };
    }
    return {};
  };

  const r = await actualizarDatosCliente({ contact: 5 }, undefined, { nombre: 'Ana', email: 'nuevo@correo.cl' }, auth);

  assert.equal(r.ok, true);
  assert.deepEqual(r.actualizado, ['contact#5']);

  // Se leyó el contacto para fusionar.
  assert.ok(calls.find((c) => c.method === 'crm.contact.get'), 'lee el contacto antes de fusionar');

  // El update conserva el email antiguo y agrega el nuevo.
  const update = calls.find((c) => c.method === 'crm.contact.update');
  assert.ok(update, 'actualiza el contacto');
  assert.equal(update!.params.fields.NAME, 'Ana');
  const emails = update!.params.fields.EMAIL.map((e: any) => e.VALUE);
  assert.ok(emails.includes('antiguo@correo.cl'), 'conserva el email existente');
  assert.ok(emails.includes('nuevo@correo.cl'), 'agrega el email nuevo');
  assert.equal(update!.params.fields.EMAIL.length, 2);

  // Deja la nota trazable en el timeline.
  assert.ok(calls.find((c) => c.method === 'crm.timeline.comment.add'), 'deja nota en el timeline');
});

test('actualizarDatosCliente: no duplica un email que ya está presente', async () => {
  calls.length = 0;
  responder = (method) => {
    if (method === 'crm.contact.get') {
      return { EMAIL: [{ ID: '10', VALUE: 'ana@correo.cl', VALUE_TYPE: 'WORK' }] };
    }
    return {};
  };

  await actualizarDatosCliente({ contact: 7 }, undefined, { email: 'ana@correo.cl' }, auth);

  const update = calls.find((c) => c.method === 'crm.contact.update');
  assert.ok(update, 'igual emite update');
  assert.equal(update!.params.fields.EMAIL.length, 1, 'no duplica el email ya presente');
});

test('actualizarDatosCliente: sin entidad CRM y sin chat devuelve error claro', async () => {
  calls.length = 0;
  const r = await actualizarDatosCliente({}, undefined, { nombre: 'Sin Entidad' }, auth);
  assert.equal(r.ok, false);
  assert.match(String(r.error), /entidad CRM/i);
});
