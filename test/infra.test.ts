import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';

// Verifica la infraestructura de M0 en MODO MEMORIA (sin Redis): es la ruta que corre en dev/test
// y el fallback en producción ante un fallo de Redis. Con REDIS_URL vacío, getRedisClient() → null
// y cada módulo usa su implementación en proceso.
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

const { rateLimit } = await import('../src/routes/rateLimit');
const { withKeyedLock } = await import('../src/util/distlock');
const { inc, recordLlmLatency, snapshot } = await import('../src/obs/metrics');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Fakes mínimos de Express para ejercitar el middleware sin levantar un servidor.
function fakeReq(ip: string): Request {
  return { ip, query: {}, header: () => undefined } as unknown as Request;
}
function fakeRes() {
  const res: any = { statusCode: 200, headers: {} as Record<string, string>, body: undefined };
  res.set = (k: string, v: string) => ((res.headers[k] = v), res);
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  return res as Response & { statusCode: number; headers: Record<string, string>; body: any };
}

test('rateLimit (memoria): deja pasar hasta max y luego responde 429 con Retry-After', async () => {
  const mw = rateLimit({ name: 'test', windowMs: 60_000, max: 2 });
  const ip = '10.0.0.1';
  let passed = 0;
  const run = async () => {
    const res = fakeRes();
    await mw(fakeReq(ip), res, () => { passed++; });
    return res;
  };
  const r1 = await run();
  const r2 = await run();
  const r3 = await run();
  assert.equal(passed, 2, 'las primeras 2 peticiones pasan');
  assert.equal(r1.statusCode, 200);
  assert.equal(r2.statusCode, 200);
  assert.equal(r3.statusCode, 429, 'la 3ª excede el límite');
  assert.equal(r3.body.error, 'rate limit');
  assert.ok(r3.headers['Retry-After'], 'incluye Retry-After');
});

test('rateLimit (memoria): el límite es por clave (IP) independiente', async () => {
  const mw = rateLimit({ name: 'perkey', windowMs: 60_000, max: 1 });
  const hit = async (ip: string) => {
    const res = fakeRes();
    let ok = false;
    await mw(fakeReq(ip), res, () => { ok = true; });
    return ok;
  };
  assert.equal(await hit('1.1.1.1'), true);
  assert.equal(await hit('2.2.2.2'), true, 'otra IP no comparte cupo');
  assert.equal(await hit('1.1.1.1'), false, 'la misma IP ya agotó su cupo');
});

test('withKeyedLock (memoria): serializa la misma clave y deja concurrir claves distintas', async () => {
  const order: string[] = [];
  const task = (key: string, id: string, ms: number) =>
    withKeyedLock(key, async () => {
      order.push('s' + id);
      await sleep(ms);
      order.push('e' + id);
    });
  // Misma clave: no se solapan (s1,e1,s2,e2). Clave distinta: puede intercalarse.
  await Promise.all([task('A', '1', 20), task('A', '2', 5)]);
  assert.deepEqual(order, ['s1', 'e1', 's2', 'e2']);
});

test('withKeyedLock (memoria): propaga el resultado de fn', async () => {
  const v = await withKeyedLock('R', async () => 42);
  assert.equal(v, 42);
});

test('metrics (memoria): inc acumula y snapshot lo refleja', async () => {
  inc('infra_test_counter', 2);
  inc('infra_test_counter');
  const s = await snapshot();
  assert.equal(s.counters['infra_test_counter'], 3);
});

test('metrics (memoria): latencia calcula avg y p95', async () => {
  recordLlmLatency(100);
  recordLlmLatency(200);
  recordLlmLatency(300);
  const s = await snapshot();
  assert.ok(s.llm.samples >= 3);
  assert.ok(s.llm.avgMs > 0);
  assert.ok(s.llm.p95Ms > 0);
});
