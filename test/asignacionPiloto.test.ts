import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// BIT-04: la caché "este deal no es del piloto" (asignacion:nopiloto:deal#) se fijaba en el PRIMER
// mensaje, antes de que el bot capturara el programa. Como vale 24 h y el atajo corta antes de
// releer el deal, cuando el cliente declaraba después un programa piloto la asignación quedaba
// bloqueada un día. Correcciones: (1) no cachear "no piloto" si aún no se conoce el programa;
// (2) olvidarNoPiloto() invalida la caché al capturar el programa (lo llama crm/crmWrite.ts).
process.env.REDIS_URL = '';
process.env.NODE_ENV = 'test';
process.env.BITRIX_UF_PROGRAMA = 'UF_CRM_PROGRAMA_TEST';

type Call = { method: string; params: any };
const calls: Call[] = [];
let uf: Record<number, string> = {};
let title: Record<number, string> = {};

mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callCrm: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === 'crm.deal.get') return { UF_CRM_PROGRAMA_TEST: uf[params.id] ?? '', TITLE: title[params.id] ?? '', ASSIGNED_BY_ID: 0 };
      if (method === 'tasks.task.add') return { task: { id: 9 } };
      return {};
    },
    callBitrix: async () => ({}),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: {} }),
    callWebhook: async () => ({}),
  },
});

const contadores = new Map<string, number>();
const usados = new Set<string>();
const claves = new Map<string, string>();
const fakeRedis = {
  incr: async (k: string) => { const n = (contadores.get(k) ?? 0) + 1; contadores.set(k, n); return n; },
  exists: async (k: string) => (claves.has(k) ? 1 : 0),
  get: async (k: string) => claves.get(k) ?? null,
  set: async (k: string, v: string) => { claves.set(k, v); return 'OK'; },
  del: async (k: string) => { const had = claves.delete(k); return had ? 1 : 0; },
};
mock.module('../src/store/kv.ts', {
  namedExports: {
    getRedisClient: () => fakeRedis,
    once: async (key: string) => { if (usados.has(key)) return false; usados.add(key); claves.set(key, '1'); return true; },
  },
});

const { asignarAsesorPorTurno, olvidarNoPiloto } = await import('../src/crm/asignacionAsesores');
const auth = { domain: '', access_token: '' } as any;
const PILOTO = 'Diplomado en Inteligencia Artificial'; // piloto por defecto (Postgrados)
const asignado = (dealId: number) => calls.some((c) => c.method === 'crm.deal.update' && c.params.id === dealId && c.params.fields?.ASSIGNED_BY_ID);
const NOPILOTO = (dealId: number) => claves.has(`asignacion:nopiloto:deal#${dealId}`);

function reset() { calls.length = 0; contadores.clear(); usados.clear(); claves.clear(); uf = {}; title = {}; }

test('sin programa aún (UF y TITLE vacíos) NO se cachea "no piloto"', async () => {
  reset();
  // deal 500 sin programa todavía
  const r = await asignarAsesorPorTurno({ deal: 500 }, auth, 'automatico');
  assert.equal(r, false, 'no asigna porque no sabe el programa');
  assert.equal(NOPILOTO(500), false, 'y no deja la caché que bloquearía 24 h');
});

test('tras capturar el programa piloto, la asignación SÍ ocurre (antes la bloqueaba la caché)', async () => {
  reset();
  await asignarAsesorPorTurno({ deal: 501 }, auth, 'automatico'); // turno 1: sin programa
  uf[501] = PILOTO; // el cliente declara el programa
  const r = await asignarAsesorPorTurno({ deal: 501 }, auth, 'automatico'); // turno 2
  assert.equal(r, true);
  assert.ok(asignado(501), 'se asignó al asesor del piloto');
});

test('olvidarNoPiloto borra una caché ya fijada y permite asignar', async () => {
  reset();
  claves.set('asignacion:nopiloto:deal#502', '1'); // caché vieja de un turno sin programa
  uf[502] = PILOTO;
  await olvidarNoPiloto(502);
  assert.equal(NOPILOTO(502), false);
  const r = await asignarAsesorPorTurno({ deal: 502 }, auth, 'automatico');
  assert.equal(r, true);
  assert.ok(asignado(502));
});

test('control: un programa que NO es del piloto SÍ se cachea (no cambia ese comportamiento)', async () => {
  reset();
  uf[503] = 'Magíster en Gestión'; // no piloto, con el programa YA conocido (UF poblado)
  const r = await asignarAsesorPorTurno({ deal: 503 }, auth, 'automatico');
  assert.equal(r, false);
  assert.equal(NOPILOTO(503), true, 'sí se recuerda para no reconsultar en cada turno');
});
