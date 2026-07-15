import { test } from 'node:test';
import assert from 'node:assert/strict';

// Aísla los módulos de dependencias externas: sin Redis/Postgres reales y con clave de cifrado de prueba.
// Se define ANTES de importar (dinámicamente) los módulos que leen config al cargarse.
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';
process.env.TOKEN_ENC_KEY =
  process.env.TOKEN_ENC_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const { encryptToken, decryptToken } = await import('../src/store/tokenCrypto');
const { createSemaphore, createKeyedLock } = await import('../src/util/concurrency');
const { parseAllEntities, parseEntityData2, primaryEntity } = await import('../src/crm/entities');
const { normalizeCall, tipoLabel, estadoLabel } = await import('../src/crm/callStats');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('tokenCrypto: roundtrip + passthrough + no re-cifra', () => {
  const secret = 'token_secreto_123';
  const enc = encryptToken(secret)!;
  assert.ok(enc.startsWith('enc:v1:'));
  assert.equal(decryptToken(enc), secret);
  assert.equal(decryptToken('texto_plano'), 'texto_plano');
  assert.equal(encryptToken(enc), enc);
});

test('parseAllEntities: extrae ids > 0 por tipo', () => {
  assert.deepEqual(parseAllEntities('LEAD|1209|COMPANY|0|CONTACT|55|DEAL|0'), { lead: 1209, contact: 55 });
  assert.deepEqual(parseAllEntities(''), {});
  assert.deepEqual(parseAllEntities(undefined), {});
});

test('parseEntityData2 + primaryEntity: prioridad deal > contact > lead > company', () => {
  assert.deepEqual(parseEntityData2('LEAD|1|DEAL|7'), { type: 'deal', id: 7 });
  assert.deepEqual(primaryEntity({ lead: 1, contact: 2 }), { type: 'contact', id: 2 });
  assert.equal(parseEntityData2('LEAD|0|DEAL|0'), null);
});

test('normalizeCall: mapea campos y clasifica saliente/contestada', () => {
  const n = normalizeCall({
    ID: '10',
    CALL_START_DATE: '2026-07-08T14:30:00+00:00',
    CALL_TYPE: '1',
    PHONE_NUMBER: '+56911112222',
    CALL_DURATION: '42',
    PORTAL_USER_ID: '5',
    CALL_FAILED_CODE: '200',
    CALL_RECORD_URL: 'http://x',
  });
  assert.equal(n.id, '10');
  assert.equal(n.isOutbound, true);
  assert.equal(n.hora, 14);
  assert.equal(n.contestada, true);
  assert.equal(n.duracion, 42);
});

test('tipoLabel / estadoLabel (incluye sufijo del proveedor)', () => {
  assert.equal(tipoLabel(1), 'saliente');
  assert.equal(tipoLabel(2), 'entrante');
  assert.equal(estadoLabel('200'), 'Contestada');
  assert.equal(estadoLabel('603-S'), 'Rechazada');
});

test('createKeyedLock: serializa la misma clave', async () => {
  const lock = createKeyedLock();
  const order: string[] = [];
  const t = (id: string, ms: number) =>
    lock('K', async () => {
      order.push('s' + id);
      await sleep(ms);
      order.push('e' + id);
    });
  await Promise.all([t('1', 20), t('2', 5)]);
  assert.deepEqual(order, ['s1', 'e1', 's2', 'e2']);
});

test('createSemaphore: no supera el máximo de concurrencia', async () => {
  const sem = createSemaphore(2);
  let c = 0,
    m = 0;
  const t = () =>
    sem(async () => {
      c++;
      m = Math.max(m, c);
      await sleep(10);
      c--;
    });
  await Promise.all([t(), t(), t(), t()]);
  assert.equal(m, 2);
});
