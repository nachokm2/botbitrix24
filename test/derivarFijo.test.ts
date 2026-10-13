import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Derivación con punto de entrada único.
//
// La regla cambió: antes toda derivación reasignaba la negociación a esa persona, y eso dejó 165
// negociaciones de Carver en manos de una sola, quitándoselas a los asesores que las venían
// trabajando. Ahora, si ya hay un asesor vigente a cargo, el lead SIGUE SIENDO SUYO y se le avisa
// con una tarea; el punto de entrada solo recibe lo que no tiene dueño real.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.BITRIX_DERIVAR_A = '1313';

const llamadas: { method: string; params: any }[] = [];
let responsableActual = 777;
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: async (method: string, params: any) => {
      llamadas.push({ method, params });
      return {};
    },
    callCrm: async (method: string, params: any) => {
      llamadas.push({ method, params });
      if (method === 'crm.deal.get') return { ASSIGNED_BY_ID: String(responsableActual), TITLE: 'Maestría en Psicología – Ana' };
      if (method === 'crm.deal.list') return [{ ID: '4242' }];
      if (method === 'tasks.task.add') return { task: { id: 99 } };
      return {};
    },
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: [], total: 0, next: null }),
    callWebhook: async () => ({}),
  },
});

let activos = new Set<number>([777, 888]);
mock.module('../src/crm/directory.ts', {
  namedExports: {
    getUsuarios: async (ids: number[]) => ids.map((id) => ({ id, nombre: `Asesor ${id}`, activo: activos.has(id) })),
  },
});

mock.module('../src/obs/audit.ts', { namedExports: { audit: async () => {} } });

const { derivarAResponsableFijo } = await import('../src/crm/asignacionAsesores');
const { config } = await import('../src/config');
const auth = { domain: 'test.bitrix24.com', access_token: 'tok' } as any;

const update = () => llamadas.find((c) => c.method === 'crm.deal.update');
const tarea = () => llamadas.find((c) => c.method === 'tasks.task.add');

function reset(responsable: number) {
  llamadas.length = 0;
  responsableActual = responsable;
  activos = new Set([777, 888]);
  config.responsablesPorDefecto = [45, 1];
  config.embudosPropios = [];
}

test('si ya hay un asesor vigente, NO se le quita el lead: se le crea una tarea', async () => {
  reset(777);
  const ok = await derivarAResponsableFijo({ deal: 500 }, auth);

  assert.equal(ok, true);
  assert.equal(update(), undefined, 'el lead sigue siendo del asesor que lo trabajaba');
  assert.equal(tarea()!.params.fields.RESPONSIBLE_ID, 777);
  assert.match(tarea()!.params.fields.DESCRIPTION, /sigue siendo tuya/);
  assert.deepEqual(tarea()!.params.fields.UF_CRM_TASK, ['D_500'], 'la tarea queda colgada de la negociación');
});

test('sin asesor real, el punto de entrada sí la recibe', async () => {
  reset(45); // responsable por defecto / robot
  const ok = await derivarAResponsableFijo({ deal: 501 }, auth);

  assert.equal(ok, true);
  assert.equal(update()!.params.fields.ASSIGNED_BY_ID, 1313);
  assert.equal(tarea()!.params.fields.RESPONSIBLE_ID, 1313);
});

test('un asesor dado de baja no conserva el lead', async () => {
  // Dejárselo sería mandarlo a un buzón donde nadie mira: al limpiar Carver aparecieron 8 asesores
  // de baja en el historial, uno con 46 negociaciones.
  reset(999); // no está en `activos`
  await derivarAResponsableFijo({ deal: 502 }, auth);
  assert.equal(update()!.params.fields.ASSIGNED_BY_ID, 1313);
});

test('si ya es del punto de entrada, no reescribe pero sí avisa', async () => {
  reset(1313);
  const ok = await derivarAResponsableFijo({ deal: 503 }, auth);

  assert.equal(ok, true);
  assert.equal(update(), undefined, 'escribir de nuevo lo mismo es ruido en el timeline');
  assert.equal(tarea()!.params.fields.RESPONSIBLE_ID, 1313);
});

test('no repite la tarea si el cliente escribe varias veces seguidas', async () => {
  reset(888);
  await derivarAResponsableFijo({ deal: 777000 }, auth);
  const primera = llamadas.filter((c) => c.method === 'tasks.task.add').length;
  await derivarAResponsableFijo({ deal: 777000 }, auth);
  await derivarAResponsableFijo({ deal: 777000 }, auth);
  const total = llamadas.filter((c) => c.method === 'tasks.task.add').length;
  assert.equal(total, primera, 'tres mensajes en una tarde no son tres tareas');
});

// La mitad de los chats entran vinculados solo a un CONTACTO, sin negociación: sin buscarla, esas
// derivaciones se perderían.
test('sin negociación en el chat, la busca por el contacto', async () => {
  reset(45);
  const ok = await derivarAResponsableFijo({ contact: 9001 }, auth);

  assert.equal(ok, true);
  assert.equal(update()!.params.id, 4242, 'la negociación que encontró por el contacto');
});

test('sin negociación ni contacto, no inventa a quién asignar', async () => {
  reset(777);
  assert.equal(await derivarAResponsableFijo({}, auth), false);
  assert.equal(update(), undefined);
  assert.equal(tarea(), undefined);
});
