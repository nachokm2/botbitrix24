import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// asignarAsesorPorTurno: asignación round-robin (Norte/Sur) + tarea de seguimiento, SOLO para los 2
// programas piloto de la marcha blanca, disparada al escalar a un humano. No confía en la regla de
// "asesor por oferta" de Bitrix (se confirmó que no reasigna un deal con responsable ya fijado —
// ver deal real #3490881, Katherine).
process.env.REDIS_URL = '';
process.env.NODE_ENV = 'test';
process.env.BITRIX_UF_PROGRAMA = 'UF_CRM_PROGRAMA_TEST';

type Call = { method: string; params: any };
const calls: Call[] = [];
let dealProgramas: Record<number, string> = {};
let dealPorContacto: Record<number, number> = {}; // contactId -> dealId (simula crm.deal.list)

mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: async (method: string, params: any) => record(method, params),
    callCrm: async (method: string, params: any) => record(method, params),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: {} }),
    callWebhook: async () => ({}),
  },
});
async function record(method: string, params: any) {
  calls.push({ method, params });
  if (method === 'crm.deal.get') return { UF_CRM_PROGRAMA_TEST: dealProgramas[params.id] ?? '', TITLE: 'x' };
  if (method === 'crm.deal.list') {
    const dealId = dealPorContacto[params.filter?.CONTACT_ID];
    return dealId ? [{ ID: String(dealId) }] : [];
  }
  if (method === 'tasks.task.add') return { task: { id: 999 } };
  return {};
}

// Fake Redis: solo lo que asignacionAsesores.ts usa (incr por key). once() replica el comportamiento
// real (primer llamado por key → true; siguientes → false), SIN depender de Redis de verdad.
const contadores = new Map<string, number>();
const usados = new Set<string>();
const fakeRedis = { incr: async (key: string) => { const n = (contadores.get(key) ?? 0) + 1; contadores.set(key, n); return n; } };
mock.module('../src/store/kv.ts', {
  namedExports: {
    getRedisClient: () => fakeRedis,
    once: async (key: string) => { if (usados.has(key)) return false; usados.add(key); return true; },
  },
});

const { asignarAsesorPorTurno } = await import('../src/crm/asignacionAsesores');
const auth = { domain: '', access_token: '' } as any;

test('asignarAsesorPorTurno: alterna Norte/Sur entre deals distintos del mismo programa', async () => {
  calls.length = 0;
  dealProgramas = { 201: 'Diplomado en Inteligencia Artificial', 202: 'Diplomado en Inteligencia Artificial' };

  await asignarAsesorPorTurno({ deal: 201 }, auth);
  await asignarAsesorPorTurno({ deal: 202 }, auth);

  const upd201 = calls.find((c) => c.method === 'crm.deal.update' && c.params.id === 201);
  const upd202 = calls.find((c) => c.method === 'crm.deal.update' && c.params.id === 202);
  assert.equal(upd201!.params.fields.ASSIGNED_BY_ID, 283901, 'primer turno: Zaida (Norte)');
  assert.equal(upd202!.params.fields.ASSIGNED_BY_ID, 368819, 'segundo turno: Constanza (Sur)');

  const tarea201 = calls.find((c) => c.method === 'tasks.task.add' && c.params.fields.RESPONSIBLE_ID === 283901);
  assert.ok(tarea201, 'crea la tarea para el asesor recién asignado');
  assert.ok(tarea201!.params.fields.DEADLINE, 'la tarea tiene plazo');
});

test('asignarAsesorPorTurno: no hace nada si el programa no es uno de los 2 piloto', async () => {
  calls.length = 0;
  dealProgramas = { 203: 'Diplomado en Marketing Digital' };

  await asignarAsesorPorTurno({ deal: 203 }, auth);

  assert.ok(!calls.find((c) => c.method === 'crm.deal.update'), 'no reasigna un programa fuera del piloto');
  assert.ok(!calls.find((c) => c.method === 'tasks.task.add'), 'no crea tarea');
});

test('asignarAsesorPorTurno: motivo="silencio" usa el texto NO urgente de la tarea', async () => {
  calls.length = 0;
  dealProgramas = { 205: 'Diplomado en Intervención Terapéutica Familiar' };

  await asignarAsesorPorTurno({ deal: 205 }, auth, 'silencio');

  const tarea = calls.find((c) => c.method === 'tasks.task.add');
  assert.ok(tarea, 'igual crea la tarea');
  assert.match(tarea!.params.fields.TITLE, /Contacto temprano/i, 'título distinto al de un escalado explícito');
  assert.match(tarea!.params.fields.DESCRIPTION, /no es urgente/i, 'la descripción aclara que no es urgente');
});

test('asignarAsesorPorTurno: sin deal pero con contacto, busca un deal existente vinculado a ese contacto', async () => {
  calls.length = 0;
  dealPorContacto = { 909527: 401 };
  dealProgramas = { 401: 'Diplomado en Intervención Terapéutica Familiar' };

  const asignado = await asignarAsesorPorTurno({ contact: 909527 }, auth);

  assert.equal(asignado, true, 'encuentra el deal por el contacto y sí asigna');
  const upd = calls.find((c) => c.method === 'crm.deal.update');
  assert.equal(upd?.params.id, 401, 'usa el deal encontrado, no uno inventado');
  assert.ok(calls.find((c) => c.method === 'tasks.task.add' && c.params.fields.UF_CRM_TASK?.[0] === 'D_401'));
});

test('asignarAsesorPorTurno: sin deal y sin ningún deal vinculado al contacto, no hace nada (y no cuenta como asignado)', async () => {
  calls.length = 0;
  dealPorContacto = {};

  const asignado = await asignarAsesorPorTurno({ contact: 999999 }, auth);

  assert.equal(asignado, false);
  assert.ok(!calls.find((c) => c.method === 'crm.deal.update'));
});

test('asignarAsesorPorTurno: no reasigna ni duplica la tarea si se llama dos veces para el mismo deal', async () => {
  calls.length = 0;
  dealProgramas = { 204: 'Diplomado en Intervención Terapéutica Familiar' };

  await asignarAsesorPorTurno({ deal: 204 }, auth);
  calls.length = 0; // limpia para verificar solo la SEGUNDA pasada (el crm.deal.get de lectura sí se repite; el punto es que no vuelve a ESCRIBIR)
  await asignarAsesorPorTurno({ deal: 204 }, auth);

  assert.ok(!calls.find((c) => c.method === 'crm.deal.update'), 'la segunda vez no reasigna');
  assert.ok(!calls.find((c) => c.method === 'tasks.task.add'), 'la segunda vez no duplica la tarea');
});
