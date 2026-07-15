import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';

// Caso complementario a test/guard.test.ts: sin BASE_URL ni WEBCHAT_ALLOWED_ORIGINS configurados,
// requireAllowedOrigin no debe restringir nada (comportamiento previo a ALT-Alta-2, sin romper prod
// en despliegues que aún no configuraron la allowlist). Va en un archivo aparte porque
// config.webchatAllowedOrigins se fija una sola vez al importar src/config.ts.
process.env.NODE_ENV = 'test';
// OJO: asignar '' en vez de "delete" — config.ts hace `import 'dotenv/config'`, que solo rellena
// variables AUSENTES desde el .env real del repo; si se borraran, dotenv las repondría igual.
process.env.BASE_URL = '';
process.env.WEBCHAT_ALLOWED_ORIGINS = '';

const { requireAllowedOrigin } = await import('../src/routes/guard');

function fakeReq(headers: Record<string, string>): Request {
  return { header: (name: string) => headers[name.toLowerCase()] } as unknown as Request;
}
function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  return res as Response & { statusCode: number; body: any };
}

test('requireAllowedOrigin: sin allowlist configurada, no restringe (fail-open)', () => {
  const req = fakeReq({});
  const res = fakeRes();
  let called = false;
  requireAllowedOrigin(req, res, () => { called = true; });
  assert.equal(called, true);
});
