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
let dealResponsable: Record<number, number> = {}; // dealId -> ASSIGNED_BY_ID actual

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
  if (method === 'crm.deal.get')
    return { UF_CRM_PROGRAMA_TEST: dealProgramas[params.id] ?? '', TITLE: 'x', ASSIGNED_BY_ID: dealResponsable[params.id] ?? 0 };
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
const claves = new Map<string, string>();
const fakeRedis = {
  incr: async (key: string) => { const n = (contadores.get(key) ?? 0) + 1; contadores.set(key, n); return n; },
  // La asignación usa estos 3 además de incr: exists (atajo para no consultar Bitrix en cada turno),
  // get/set (recuerda a qué asesor le tocó el deal, para corregir sin gastar otro turno).
  exists: async (key: string) => (claves.has(key) ? 1 : 0),
  get: async (key: string) => claves.get(key) ?? null,
  set: async (key: string, val: string) => { claves.set(key, val); return 'OK'; },
};
mock.module('../src/store/kv.ts', {
  namedExports: {
    getRedisClient: () => fakeRedis,
    // once() escribe la MISMA llave que luego lee exists() — en Redis de verdad es una sola clave,
    // así que el fake debe compartirla o el atajo de "ya asignado" nunca se activaría en las pruebas.
    once: async (key: string) => {
      if (usados.has(key)) return false;
      usados.add(key);
      claves.set(key, '1');
      return true;
    },
  },
});

const { asignarAsesorPorTurno } = await import('../src/crm/asignacionAsesores');
const { config } = await import('../src/config');
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

test('asignarAsesorPorTurno: motivo="automatico" usa el texto de "nuevo lead" (no urgente, sin mencionar escalada)', async () => {
  calls.length = 0;
  dealProgramas = { 206: 'Diplomado en Inteligencia Artificial' };

  const asignado = await asignarAsesorPorTurno({ deal: 206 }, auth, 'automatico');

  assert.equal(asignado, true);
  const tarea = calls.find((c) => c.method === 'tasks.task.add');
  assert.ok(tarea, 'igual crea la tarea (para que el asesor sepa que tiene un lead nuevo)');
  assert.match(tarea!.params.fields.TITLE, /Nuevo lead/i);
  assert.doesNotMatch(tarea!.params.fields.DESCRIPTION, /escaló/i, 'no da a entender que hubo una escalada');
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

// ── Corrección del responsable al escalar ──────────────────────────────────────────────────────
// Caso real: el bot asignó el deal #3578969 a Joaquín y un minuto después el responsable volvió al
// responsable POR DEFECTO del embudo (un usuario con 3.599 deals, que no es un asesor). Al escalar,
// el bot avisaba al cliente ESE nombre. Decisión del usuario: corregir SOLO si el deal está en ese
// responsable por defecto; si lo tiene cualquier otra persona, se respeta.

test('escalado: si el deal volvió al responsable por defecto, lo corrige al asesor que le tocó', async () => {
  calls.length = 0;
  dealProgramas[700] = 'Diplomado en Intervención Terapéutica Familiar';
  const original = config.responsablesPorDefecto.slice();
  config.responsablesPorDefecto.push(4173);
  try {
    await asignarAsesorPorTurno({ deal: 700 }, auth); // asignación inicial
    const asignado = calls.find((c) => c.method === 'crm.deal.update')!.params.fields.ASSIGNED_BY_ID;

    dealResponsable[700] = 4173; // alguien (o una automatización) lo devolvió al default
    calls.length = 0;
    const ok = await asignarAsesorPorTurno({ deal: 700 }, auth, 'escalado');

    assert.equal(ok, true, 'debe corregirlo');
    const update = calls.find((c) => c.method === 'crm.deal.update');
    assert.equal(update?.params.fields.ASSIGNED_BY_ID, asignado, 'vuelve al MISMO asesor, sin gastar otro turno');
    assert.ok(!calls.some((c) => c.method === 'tasks.task.add'), 'no duplica la tarea');
  } finally {
    config.responsablesPorDefecto.length = 0;
    config.responsablesPorDefecto.push(...original);
  }
});

test('escalado: si el deal lo tiene otra persona (no el responsable por defecto), NO se lo quita', async () => {
  calls.length = 0;
  dealProgramas[701] = 'Diplomado en Inteligencia Artificial';
  const original = config.responsablesPorDefecto.slice();
  config.responsablesPorDefecto.push(4173);
  try {
    await asignarAsesorPorTurno({ deal: 701 }, auth);
    dealResponsable[701] = 99999; // otro asesor real tomó el deal
    calls.length = 0;
    const ok = await asignarAsesorPorTurno({ deal: 701 }, auth, 'escalado');
    assert.equal(ok, false);
    assert.ok(!calls.some((c) => c.method === 'crm.deal.update'), 'respeta la asignación de un asesor real');
  } finally {
    config.responsablesPorDefecto.length = 0;
    config.responsablesPorDefecto.push(...original);
  }
});

test('crearTarea=false: asigna el deal al asesor pero NO le crea una tarea', async () => {
  calls.length = 0;
  dealProgramas[702] = 'Diplomado en Intervención Terapéutica Familiar';
  const ok = await asignarAsesorPorTurno({ deal: 702 }, auth, 'automatico', { crearTarea: false });
  assert.equal(ok, true);
  assert.ok(calls.some((c) => c.method === 'crm.deal.update'), 'sí reasigna el deal');
  assert.ok(!calls.some((c) => c.method === 'tasks.task.add'), 'pero no genera pendientes por una consulta suelta');
});
