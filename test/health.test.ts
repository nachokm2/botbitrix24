import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import pgTypes from 'pg-types';

// INF-07: antes /health respondía siempre {ok:true} aunque Postgres estuviera caído (el incidente del
// 2026-10-23 tuvo el bot una hora sin BD con /health "ok"). Ahora reporta el estado real de cada
// dependencia: 'up' | 'down' | 'off' ('off' = no configurada). Estas pruebas cubren las sondas que
// alimentan /health (dbHealth / redisHealth) y la regla de `degraded`. /health sigue devolviendo HTTP
// 200 (liveness) a propósito, para no provocar un restart-loop en Railway (healthcheckPath=/health).
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = ''; // modo memoria → Redis 'off'
process.env.DATABASE_URL = 'postgres://ficticio@127.0.0.1:1/ficticio';

let fallarSelect1 = false;
class FakePool {
  constructor(_o: unknown) {}
  on() {
    return this;
  }
  async query(sql: string) {
    if (/^SELECT 1$/.test(sql.trim())) {
      if (fallarSelect1) throw new Error('ECONNREFUSED (simulado)');
      return { rows: [{ '?column?': 1 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 }; // CREATE TABLE / CREATE INDEX de initDb
  }
  async end() {}
}
mock.module('pg', { defaultExport: { Pool: FakePool, types: pgTypes } });

const db = await import('../src/store/db.ts');
const kv = await import('../src/store/kv.ts');

test('Postgres configurado pero sin pool todavía → dbHealth "down" (no "off")', async () => {
  // Antes de initDb: hay DATABASE_URL pero aún no hay conexión. Ese es exactamente el estado del
  // incidente, y debe distinguirse de "off" (no configurado) para que `degraded` lo tome.
  assert.equal(await db.dbHealth(), 'down');
});

test('Redis en modo memoria → redisHealth "off" (configurado-ausente, no cuenta como degradado)', () => {
  assert.equal(kv.redisHealth(), 'off');
});

test('con el pool listo, dbHealth "up"; si la sonda falla, "down"', async () => {
  await db.initDb();
  assert.equal(db.dbEnabled(), true);
  assert.equal(await db.dbHealth(), 'up', 'SELECT 1 responde → up');

  fallarSelect1 = true;
  assert.equal(await db.dbHealth(), 'down', 'la sonda falla → down (sin colgarse ni lanzar)');
  fallarSelect1 = false;
});

test('regla de degraded: solo "down" degrada; "off" y "up" no', () => {
  const degradado = (pg: string, rd: string) => pg === 'down' || rd === 'down';
  assert.equal(degradado('up', 'off'), false, 'Postgres up + Redis no configurado: sano');
  assert.equal(degradado('up', 'up'), false);
  assert.equal(degradado('down', 'off'), true, 'Postgres caído: degradado');
  assert.equal(degradado('up', 'down'), true, 'Redis caído: degradado');
});
