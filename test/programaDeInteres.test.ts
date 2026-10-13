import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// El campo "programa de interés" del CRM debe seguir a la conversación, no quedarse con el primer
// programa nombrado. El prompt ya lo pedía y el modelo no siempre lo hacía, así que ahora lo escribe
// el propio dispatch cuando el cliente pide el detalle o el precio de un programa concreto.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';

type Escritura = { entities: any; data: any };
const escrituras: Escritura[] = [];
mock.module('../src/crm/crmWrite.ts', {
  namedExports: {
    actualizarDatosCliente: async (entities: any, _chatId: any, data: any) => {
      escrituras.push({ entities, data });
      return { ok: true, actualizado: ['deal#1'] };
    },
    obtenerContextoLlamada: async () => ({}),
  },
});

// Sesión en memoria: sin Redis, getSession/saveSession no recuerdan nada y el "solo si cambia" no
// se podría probar. Replica el Map que usa store/kv.ts en los demás tests.
const sesiones = new Map<string, any>();
mock.module('../src/session.ts', {
  namedExports: {
    getSession: async (id: string) => sesiones.get(id) ?? {},
    saveSession: async (id: string, s: any) => {
      sesiones.set(id, s);
    },
    markHumanTakeover: async () => {},
    marcarTraspaso: async () => {},
    traspasoVigente: async () => null,
    sesionOpenLines: () => null,
  },
});

const { executeTool } = await import('../src/ai/toolRunner');
const { WHATSAPP_PROFILE } = await import('../src/core/channel');

const ctxBase = {
  auth: { domain: '', access_token: '' },
  botId: 1,
  crmEntity: null,
  profile: WHATSAPP_PROFILE,
} as any;
const ctxCon = (conversationId: string, crmEntities: any = { deal: 1, contact: 2 }) => ({
  ...ctxBase,
  conversationId,
  crmEntities,
});

const MAGISTER = 'Magíster en Gestión de la Inclusión y Convivencia Educativa';

/** El seguimiento es fire-and-forget: deja correr la microtarea antes de mirar lo escrito. */
const asentar = () => new Promise((r) => setTimeout(r, 0));

test('pedir el detalle de un programa lo deja como programa de interés en el CRM', async () => {
  escrituras.length = 0;
  sesiones.clear();
  await executeTool('detalle_programa', { nombre: MAGISTER }, ctxCon('p-1'));
  await asentar();

  assert.equal(escrituras.length, 1);
  assert.equal(escrituras[0].data.programa_interes, MAGISTER);
  assert.deepEqual(escrituras[0].entities, { deal: 1, contact: 2 });
});

test('preguntar el precio del mismo programa no reescribe la ficha', async () => {
  escrituras.length = 0;
  sesiones.clear();
  await executeTool('detalle_programa', { nombre: MAGISTER }, ctxCon('p-2'));
  await asentar();
  await executeTool('detalle_programa', { nombre: MAGISTER }, ctxCon('p-2'));
  await asentar();

  assert.equal(escrituras.length, 1, 'solo escribe cuando el programa cambia');
});

test('si la conversación cambia de programa, el CRM lo sigue', async () => {
  escrituras.length = 0;
  sesiones.clear();
  await executeTool('detalle_programa', { nombre: MAGISTER }, ctxCon('p-3'));
  await asentar();
  const r = await executeTool('consultar_condiciones_comerciales', { programa: 'Inteligencia Artificial' }, ctxCon('p-3'));
  await asentar();

  // Si la planilla resolvió un programa concreto, debe haberlo seguido.
  if (r.encontrado && !r.ambiguo && r.programa) {
    assert.equal(escrituras.length, 2);
    assert.equal(escrituras[1].data.programa_interes, r.programa);
  } else {
    assert.equal(escrituras.length, 1, 'sin programa resuelto no se toca la ficha');
  }
});

test('un programa inexistente no toca la ficha', async () => {
  escrituras.length = 0;
  sesiones.clear();
  await executeTool('detalle_programa', { nombre: 'Programa que no existe xyz' }, ctxCon('p-4'));
  await asentar();
  assert.equal(escrituras.length, 0);
});

test('una consulta ambigua no elige programa por el cliente', async () => {
  escrituras.length = 0;
  sesiones.clear();
  const r = await executeTool('consultar_condiciones_comerciales', { programa: 'Magíster' }, ctxCon('p-5'));
  await asentar();
  if (r.ambiguo) assert.equal(escrituras.length, 0, 'con varias opciones no se decide sola');
});

test('sin ficha en el CRM no se crea una solo por mirar el catálogo', async () => {
  escrituras.length = 0;
  sesiones.clear();
  await executeTool('detalle_programa', { nombre: MAGISTER }, ctxCon('p-6', {}));
  await asentar();
  assert.equal(escrituras.length, 0);
});

test('navegar el catálogo general no cambia el programa de interés', async () => {
  escrituras.length = 0;
  sesiones.clear();
  await executeTool('consultar_programas', { tipo: 'diplomado' }, ctxCon('p-7'));
  await asentar();
  assert.equal(escrituras.length, 0, 'solo cuenta pedir el detalle o el precio de uno concreto');
});
