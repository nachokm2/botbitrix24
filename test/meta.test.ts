import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import type { Request, Response } from 'express';

// Test de integración de M4 (Instagram/Messenger): valida el patrón "canal nuevo = perfil + adaptador +
// identidad" sobre el MISMO motor, más lo específico de Meta (handshake, firma HMAC, Send API).
// Mockea Anthropic, el cliente Bitrix y fetch global (Send API) para no tocar la red.
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';
process.env.META_VERIFY_TOKEN = 'verify-test-token';
process.env.META_APP_SECRET = 'app-secret-test';
process.env.META_PAGE_ACCESS_TOKEN = 'page-token-test';

let impl: (args: any) => Promise<any> = async () => ({ content: [{ type: 'text', text: '' }], usage: {} });

mock.module('../src/ai/client.ts', {
  namedExports: {
    anthropic: { messages: { create: (args: any) => impl(args) } },
    REASONER: 'claude-test-sonnet',
    CLASSIFIER: 'claude-test-haiku',
  },
});

const bitrixCalls: { method: string; params: any }[] = [];
let bitrixResponder: (method: string, params: any) => any = () => ({});
const record = async (method: string, params: any) => (bitrixCalls.push({ method, params }), bitrixResponder(method, params));
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: record,
    callCrm: record,
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: {} }),
    callWebhook: async () => ({}),
  },
});

const fetchCalls: { url: string; body: any }[] = [];
(globalThis as any).fetch = async (url: string, init?: any) => {
  fetchCalls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
  return { ok: true, text: async () => '', json: async () => ({}) } as Response;
};

const { metaVerify, verifyMetaSignature, metaWebhook, handleBody } = await import('../src/routes/meta');

const textResp = (text: string) => ({ content: [{ type: 'text', text }], usage: {} });
const toolResp = (id: string, name: string, input: any) => ({ content: [{ type: 'tool_use', id, name, input }], usage: {} });

function fakeReq(opts: { query?: any; body?: any; headers?: Record<string, string>; rawBody?: Buffer }): Request {
  return {
    query: opts.query ?? {},
    body: opts.body ?? {},
    header: (name: string) => opts.headers?.[name.toLowerCase()],
    rawBody: opts.rawBody,
  } as unknown as Request;
}
function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.set = () => res;
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  res.send = (b: unknown) => ((res.body = b), res);
  res.sendStatus = (c: number) => ((res.statusCode = c), res);
  return res as Response & { statusCode: number; body: any };
}

function sign(body: any): string {
  const raw = Buffer.from(JSON.stringify(body));
  return 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET!).update(raw).digest('hex');
}

test('metaVerify: token correcto responde 200 con el challenge', () => {
  const res = fakeRes();
  metaVerify(fakeReq({ query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-test-token', 'hub.challenge': 'abc123' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'abc123');
});

test('metaVerify: token incorrecto responde 403', () => {
  const res = fakeRes();
  metaVerify(fakeReq({ query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'otro', 'hub.challenge': 'abc123' } }), res);
  assert.equal(res.statusCode, 403);
});

test('verifyMetaSignature: firma válida deja pasar (next)', () => {
  const body = { object: 'page', entry: [] };
  const raw = Buffer.from(JSON.stringify(body));
  const req = fakeReq({ body, rawBody: raw, headers: { 'x-hub-signature-256': sign(body) } });
  const res = fakeRes();
  let called = false;
  verifyMetaSignature(req, res, () => { called = true; });
  assert.equal(called, true);
});

test('verifyMetaSignature: firma inválida responde 401', () => {
  const body = { object: 'page', entry: [] };
  const raw = Buffer.from(JSON.stringify(body));
  const req = fakeReq({ body, rawBody: raw, headers: { 'x-hub-signature-256': 'sha256=deadbeef' } });
  const res = fakeRes();
  let called = false;
  verifyMetaSignature(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
});

test('messenger: responde un mensaje entrante y lo envía por la Send API', async () => {
  fetchCalls.length = 0;
  impl = async () => textResp('¡Hola! Tenemos varios diplomados online. ¿Qué área te interesa?');
  await handleBody({
    object: 'page',
    entry: [{ messaging: [{ sender: { id: 'psid-messenger-1' }, message: { mid: 'mid-1', text: 'hola' } }] }],
  });
  assert.equal(fetchCalls.length, 1, 'llamó a la Send API una vez');
  assert.equal(fetchCalls[0].body.recipient.id, 'psid-messenger-1');
  assert.match(fetchCalls[0].body.message.text, /diplomado/i);
});

test('instagram: distingue el canal por "object":"instagram" y captura el lead', async () => {
  fetchCalls.length = 0;
  bitrixCalls.length = 0;
  bitrixResponder = (method) => (method === 'crm.lead.add' ? 555 : {});
  let step = 0;
  impl = async () => {
    step++;
    if (step === 1) return toolResp('t1', 'registrar_interes_crm', { nombre: 'Bruno', email: 'bruno@correo.cl' });
    return textResp('¡Gracias, Bruno! Un asesor te contactará.');
  };
  await handleBody({
    object: 'instagram',
    entry: [{ messaging: [{ sender: { id: 'psid-ig-1' }, message: { mid: 'mid-ig-1', text: 'soy Bruno, mi correo es bruno@correo.cl' } }] }],
  });
  assert.ok(bitrixCalls.find((c) => c.method === 'crm.lead.add'), 'creó un lead');
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].body.message.text, /Bruno/);
});

test('ignora mensajes duplicados (mismo mid) y ecos propios', async () => {
  fetchCalls.length = 0;
  impl = async () => textResp('respuesta');
  const evt = { object: 'page', entry: [{ messaging: [{ sender: { id: 'psid-dup' }, message: { mid: 'mid-dup-1', text: 'hola de nuevo' } }] }] };
  await handleBody(evt);
  await handleBody(evt); // mismo mid: debe ignorarse la segunda vez
  assert.equal(fetchCalls.length, 1, 'solo procesó el evento una vez');

  fetchCalls.length = 0;
  await handleBody({
    object: 'page',
    entry: [{ messaging: [{ sender: { id: 'psid-echo' }, message: { mid: 'mid-echo-1', text: 'esto lo envié yo', is_echo: true } }] }],
  });
  assert.equal(fetchCalls.length, 0, 'no responde a su propio eco');
});
