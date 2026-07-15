import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';

// requireAllowedOrigin (ALT-Alta-2 de la auditoría): allowlist de Origin/Referer para /webchat/message.
// config.webchatAllowedOrigins se calcula al importar src/config.ts, así que las env vars deben quedar
// fijadas ANTES del import (mismo patrón que test/meta.test.ts con META_*).
process.env.NODE_ENV = 'test';
process.env.BASE_URL = 'https://bot.example.com';
process.env.WEBCHAT_ALLOWED_ORIGINS = 'https://postgrados.uautonoma.cl';

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

test('requireAllowedOrigin: origen en la allowlist deja pasar (next)', () => {
  const req = fakeReq({ origin: 'https://postgrados.uautonoma.cl' });
  const res = fakeRes();
  let called = false;
  requireAllowedOrigin(req, res, () => { called = true; });
  assert.equal(called, true);
});

test('requireAllowedOrigin: el propio BASE_URL siempre está permitido', () => {
  const req = fakeReq({ origin: 'https://bot.example.com' });
  const res = fakeRes();
  let called = false;
  requireAllowedOrigin(req, res, () => { called = true; });
  assert.equal(called, true);
});

test('requireAllowedOrigin: acepta el origin derivado del Referer si falta Origin', () => {
  const req = fakeReq({ referer: 'https://postgrados.uautonoma.cl/carreras/mba' });
  const res = fakeRes();
  let called = false;
  requireAllowedOrigin(req, res, () => { called = true; });
  assert.equal(called, true);
});

test('requireAllowedOrigin: origen fuera de la allowlist responde 403', () => {
  const req = fakeReq({ origin: 'https://otro-sitio.cualquiera.com' });
  const res = fakeRes();
  let called = false;
  requireAllowedOrigin(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
});

test('requireAllowedOrigin: sin Origin ni Referer responde 403', () => {
  const req = fakeReq({});
  const res = fakeRes();
  let called = false;
  requireAllowedOrigin(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
});
