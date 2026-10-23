import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import pgTypes from 'pg-types';

// INF-05: si Postgres no está disponible al arrancar (p. ej. Railway reinició la BD), antes el pool
// quedaba en null para siempre y el bot servía sin BD hasta que alguien lo reiniciaba a mano (incidente
// del 2026-10-23). Ahora initDb reintenta en segundo plano hasta conectar, y al quedar listo dispara
// onReady UNA sola vez — ahí se arman las tareas que necesitan el pool al armarse (sync de llamadas y
// retención). Esta prueba reproduce ese arranque-con-Postgres-caído y verifica la recuperación sola.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.DATABASE_URL = 'postgres://ficticio@127.0.0.1:1/ficticio'; // Pool simulado: nunca conecta de verdad

let poolsFallidosRestantes = 0; // cuántos pools recién creados deben fallar antes de conectar
let poolsCreados = 0;
let poolsCerrados = 0;

class FakePool {
  private fallar: boolean;
  constructor(_o: unknown) {
    poolsCreados++;
    this.fallar = poolsFallidosRestantes > 0;
    if (this.fallar) poolsFallidosRestantes--;
  }
  on() {
    return this;
  }
  async query(_sql: string) {
    if (this.fallar) throw new Error('ECONNREFUSED (simulado: Postgres caído)');
    return { rows: [], rowCount: 0 };
  }
  async end() {
    poolsCerrados++;
  }
}
mock.module('pg', { defaultExport: { Pool: FakePool, types: pgTypes } });

const db = await import('../src/store/db.ts');

// Este build de node:test no trae tickAsync, así que se avanza el reloj con tick() y se drena a mano
// la cadena async que dispara el timer (setImmediate NO está mockeado: solo mockeamos setInterval).
const drenar = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

test('reconecta en segundo plano tras un fallo inicial y dispara onReady una sola vez', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  poolsFallidosRestantes = 1; // el primer intento falla; el segundo conecta
  poolsCreados = 0;
  poolsCerrados = 0;
  let readies = 0;

  await db.initDb(() => {
    readies++;
  });

  // Tras el fallo inicial: sin pool, onReady no se disparó, y el pool a medio abrir se cerró (no se fuga).
  assert.equal(db.dbEnabled(), false, 'tras el fallo inicial no hay pool');
  assert.equal(readies, 0, 'onReady no se dispara mientras no haya Postgres');
  assert.equal(poolsCerrados, 1, 'el pool fallido se cerró para no fugarlo entre reintentos');
  assert.equal(await db.dbHealth(), 'down', '/health ve Postgres caído, no "off"');

  // Pasa el intervalo de reintento (30 s) → reconecta.
  t.mock.timers.tick(30_000);
  await drenar();
  assert.equal(db.dbEnabled(), true, 'reconectó solo en segundo plano, sin reinicio manual');
  assert.equal(readies, 1, 'onReady se disparó al quedar Postgres listo');
  assert.equal(await db.dbHealth(), 'up', '/health ya ve Postgres arriba');

  // Más ticks: el timer de reintento ya se detuvo, no reconecta de nuevo ni re-dispara onReady.
  const creadosTrasConectar = poolsCreados;
  t.mock.timers.tick(120_000);
  await drenar();
  assert.equal(readies, 1, 'onReady queda en una sola vez');
  assert.equal(poolsCreados, creadosTrasConectar, 'no se siguen creando pools una vez conectado');
});
