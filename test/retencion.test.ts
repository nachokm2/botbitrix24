import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import pgTypes from 'pg-types';

// PRIV-05 (parte 2): la retención borraba solo audit_log; se extiende a las otras tablas de histórico
// con datos personales (calls: teléfono/grabación; call_attempt: grabación/transcripción/resumen).
// campaign_target queda FUERA a propósito: es estado operativo (incluye opted_out) y borrarlo
// re-habilitaría llamadas a quien se dio de baja.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.DATABASE_URL = 'postgres://ficticio@127.0.0.1:1/ficticio'; // Pool simulado: nunca conecta

const deletes: Array<{ sql: string; params: unknown[] }> = [];
let rowCountPorTabla: Record<string, number> = {};
let fallaTabla = '';

class FakePool {
  constructor(_o: unknown) {}
  on() { return this; }
  async query(sql: string, params?: unknown[]) {
    if (/^DELETE FROM/i.test(sql.trim())) {
      deletes.push({ sql: sql.trim(), params: params ?? [] });
      const m = /DELETE FROM (\w+)/i.exec(sql);
      const tabla = m?.[1] ?? '';
      if (tabla === fallaTabla) throw new Error(`fallo simulado en ${tabla}`);
      return { rowCount: rowCountPorTabla[tabla] ?? 0 };
    }
    return { rows: [], rowCount: 0 }; // CREATE TABLE / CREATE INDEX de initDb
  }
  async end() {}
}
mock.module('pg', { defaultExport: { Pool: FakePool, types: pgTypes } });

const db = await import('../src/store/db.ts');
await db.initDb();

function reset() { deletes.length = 0; rowCountPorTabla = {}; fallaTabla = ''; }

test('purga las tres tablas de histórico y NO campaign_target', async () => {
  reset();
  rowCountPorTabla = { audit_log: 10, calls: 5, call_attempt: 3 };
  const borradas = await db.dbPurgeOldData(180);

  const tablas = deletes.map((d) => /DELETE FROM (\w+)/i.exec(d.sql)![1]);
  assert.deepEqual(tablas.sort(), ['audit_log', 'call_attempt', 'calls']);
  assert.ok(!tablas.includes('campaign_target'), 'campaign_target no se toca (estado operativo, opted_out)');
  assert.deepEqual(borradas, { audit_log: 10, calls: 5, call_attempt: 3 });
});

test('cada tabla se purga por su columna de tiempo y con los días parametrizados', async () => {
  reset();
  await db.dbPurgeOldData(90);
  const porTabla = Object.fromEntries(deletes.map((d) => [/DELETE FROM (\w+)/i.exec(d.sql)![1], d]));
  assert.match(porTabla['audit_log'].sql, /WHERE ts </);
  assert.match(porTabla['calls'].sql, /WHERE ts </);
  assert.match(porTabla['call_attempt'].sql, /WHERE created_at </);
  for (const d of deletes) assert.deepEqual(d.params, ['90'], 'los días van como parámetro, no interpolados');
});

test('un fallo en una tabla no impide purgar las demás', async () => {
  reset();
  rowCountPorTabla = { audit_log: 7, call_attempt: 2 };
  fallaTabla = 'calls';
  const borradas = await db.dbPurgeOldData(180);
  assert.deepEqual(borradas, { audit_log: 7, call_attempt: 2 }, 'calls falló pero las otras se purgaron');
});

test('con days<=0 no borra nada', async () => {
  reset();
  const borradas = await db.dbPurgeOldData(0);
  assert.equal(deletes.length, 0);
  assert.deepEqual(borradas, {});
});
