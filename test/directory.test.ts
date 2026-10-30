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

const { esEmpleadoBitrix, getUsuarios } = await import('../src/crm/directory');
const { marca } = await import('../src/marca');
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

// ── El móvil del asesor, por marca ───────────────────────────────────────────────────────────────
// Este archivo corre sin MARCA, o sea como Postgrados, cuyo equipo SÍ tiene los teléfonos al día en
// Bitrix. En Carver están desactualizados y el campo no se lee (ver carverCrm.test.ts). El corte
// está en getUsuarios, el único punto que toca PERSONAL_MOBILE: así no depende de que cada
// consumidor se acuerde de no usarlo.
test('getUsuarios: en Postgrados sí trae el móvil de la ficha', async () => {
  assert.equal(marca.telefonoAsesorVigente, true, 'los números de Postgrados están al día');
  responder = (method) =>
    method === 'user.get'
      ? [{ ID: '9', NAME: 'Asesora', LAST_NAME: 'Postgrados', EMAIL: 'a@uautonoma.cl', PERSONAL_MOBILE: '+56912345678', ACTIVE: true }]
      : {};
  const [u] = await getUsuarios([9], auth);
  assert.equal(u.telefono, '+56912345678');
});

// ── Fichas recordadas ────────────────────────────────────────────────────────────────────────────
// El panel pedía a cada asesor por separado en cada refresco (cada 15 s) y, con Bitrix bloqueado,
// mostraba "Usuario 668179" aunque el nombre se hubiera leído bien minutos antes.
test('getUsuarios: un usuario ya resuelto no se vuelve a pedir a Bitrix', async () => {
  let pedidos = 0;
  responder = (method) => {
    if (method !== 'user.get') return {};
    pedidos++;
    return [{ ID: '501', NAME: 'Valezka', LAST_NAME: 'Hernández', EMAIL: 'v@x.cl', ACTIVE: true }];
  };
  await getUsuarios([501], auth);
  const [u] = await getUsuarios([501], auth);
  assert.equal(u.nombre, 'Valezka Hernández');
  assert.equal(pedidos, 1);
});

test('getUsuarios: si Bitrix falla, se usa el nombre ya conocido aunque haya vencido', async () => {
  responder = (method) =>
    method === 'user.get' ? [{ ID: '502', NAME: 'Ignacio', LAST_NAME: 'Asesor', EMAIL: 'i@x.cl', ACTIVE: true }] : {};
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    await getUsuarios([502], auth);
    mock.timers.tick(2 * 60 * 60 * 1000); // vencido: se intenta leer de nuevo
    responder = () => {
      throw new Error('Bitrix user.get: OVERLOAD_LIMIT REST API is blocked due to overload.');
    };
    const [u] = await getUsuarios([502], auth);
    assert.equal(u.nombre, 'Ignacio Asesor');
  } finally {
    mock.timers.reset();
  }
});

test('getUsuarios: un usuario nunca resuelto sigue cayendo al número', async () => {
  responder = () => {
    throw new Error('Bitrix user.get: OVERLOAD_LIMIT REST API is blocked due to overload.');
  };
  const [u] = await getUsuarios([503], auth);
  assert.equal(u.nombre, 'Usuario 503');
});

test('getUsuarios: un vacío (participante externo) no se recuerda', async () => {
  let pedidos = 0;
  responder = (method) => {
    if (method === 'user.get') pedidos++;
    return [];
  };
  await getUsuarios([504], auth);
  await getUsuarios([504], auth);
  assert.equal(pedidos, 2);
});
