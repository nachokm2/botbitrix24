import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';

// Test de integración de M3 (Web Chat): valida el patrón "canal nuevo = perfil + adaptador + identidad"
// sobre el MISMO motor. Mockea Anthropic y el cliente Bitrix (para captura de lead sin red).
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

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

// iniciarLlamadaSaliente (solicitar_llamada) llama a la API de Vapi por fetch() directo — se mockea
// para no depender de la red/credenciales reales en el test.
const realFetch = globalThis.fetch;
(globalThis as any).fetch = async (url: string, init?: any) => {
  if (String(url).startsWith('https://api.vapi.ai/')) {
    return { ok: true, json: async () => ({ id: 'call-test-1' }) } as any;
  }
  return realFetch(url as any, init);
};

const { webchatMessage } = await import('../src/routes/webchat');

const textResp = (text: string) => ({ content: [{ type: 'text', text }], usage: {} });
const toolResp = (id: string, name: string, input: any) => ({ content: [{ type: 'tool_use', id, name, input }], usage: {} });

function fakeReq(body: any): Request {
  return { body, header: () => undefined } as unknown as Request;
}
function fakeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.set = () => res;
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), res);
  return res as Response & { statusCode: number; body: any };
}

test('webchat: responde preguntas y devuelve un conversationId', async () => {
  impl = async () => textResp('Tenemos varios magísteres online. ¿Qué área te interesa?');
  const res = fakeRes();
  await webchatMessage(fakeReq({ conversationId: 'wc-abc123', message: 'hola, ¿qué magísteres tienen?' }), res);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.conversationId, 'wc-abc123');
  assert.match(res.body.reply, /magíster/i);
});

test('webchat: identidad segura — rechaza un id ajeno y genera uno con prefijo wc-', async () => {
  impl = async () => textResp('¡Hola!');
  const res = fakeRes();
  // Un cliente malicioso intenta pasar un dialogId de Open Lines para leer su memoria.
  await webchatMessage(fakeReq({ conversationId: 'chat1209', message: 'hola' }), res);
  assert.notEqual(res.body.conversationId, 'chat1209', 'no reutiliza el id ajeno');
  assert.match(res.body.conversationId, /^wc-/, 'genera un id namespaced del canal web');
});

test('webchat: captura de lead — registrar_interes_crm crea un lead en el CRM', async () => {
  bitrixCalls.length = 0;
  bitrixResponder = (method) => (method === 'crm.lead.add' ? 999 : {});
  let step = 0;
  impl = async () => {
    step++;
    if (step === 1) return toolResp('t1', 'registrar_interes_crm', { nombre: 'Ana', email: 'ana@correo.cl' });
    return textResp('¡Gracias, Ana! Un asesor te contactará.');
  };
  const res = fakeRes();
  await webchatMessage(fakeReq({ conversationId: 'wc-lead01', message: 'soy Ana, mi correo es ana@correo.cl' }), res);
  assert.equal(res.body.ok, true);
  assert.match(res.body.reply, /Ana/);
  assert.ok(bitrixCalls.find((c) => c.method === 'crm.lead.add'), 'creó un lead web');
});

test('webchat: consultar_condiciones_comerciales devuelve el precio (antes caía en UNKNOWN_TOOL — ver socialText.ts)', async () => {
  bitrixCalls.length = 0;
  bitrixResponder = () => ({});
  let step = 0;
  let toolResult: any;
  impl = async (args: any) => {
    step++;
    if (step === 1) return toolResp('t1', 'consultar_condiciones_comerciales', { programa: 'Magíster en Inteligencia Artificial' });
    // Segundo turno: el resultado de la tool viaja como tool_result en el último mensaje 'user'.
    const last = args.messages[args.messages.length - 1];
    const block = Array.isArray(last?.content) ? last.content.find((b: any) => b.type === 'tool_result') : undefined;
    toolResult = block ? JSON.parse(block.content) : undefined;
    return textResp('El arancel es de $6.990.000.');
  };
  const res = fakeRes();
  await webchatMessage(fakeReq({ conversationId: 'wc-precio1', message: '¿cuánto vale el magíster en inteligencia artificial?' }), res);
  assert.equal(res.body.ok, true);
  assert.equal(toolResult?.encontrado, true, 'la tool encuentra el programa (no UNKNOWN_TOOL)');
  assert.equal(toolResult?.cotizable, true);
  assert.equal(toolResult?.arancel, '$6.990.000');
});

test('webchat: solicitar_llamada ya está enganchada (antes caía en UNKNOWN_TOOL — ver socialText.ts)', async () => {
  bitrixCalls.length = 0;
  bitrixResponder = (method) => (method === 'crm.lead.add' ? 1001 : {});
  let step = 0;
  let toolResult: any;
  impl = async (args: any) => {
    step++;
    if (step === 1) return toolResp('t1', 'solicitar_llamada', { telefono: '+56911112222' });
    const last = args.messages[args.messages.length - 1];
    const block = Array.isArray(last?.content) ? last.content.find((b: any) => b.type === 'tool_result') : undefined;
    toolResult = block ? JSON.parse(block.content) : undefined;
    return textResp('Intentando la llamada.');
  };
  const res = fakeRes();
  await webchatMessage(fakeReq({ conversationId: 'wc-llamada1', message: 'llámenme al +56911112222' }), res);
  assert.equal(res.body.ok, true);
  assert.equal(toolResult?.ok, true, 'la tool corre (antes devolvía UNKNOWN_TOOL porque el case no existía)');
  assert.equal(toolResult?.llamando, true);
  assert.ok(bitrixCalls.find((c) => c.method === 'crm.lead.add'), 'crea el lead antes de disparar la llamada');
});

test('webchat: mensaje vacío devuelve 400', async () => {
  const res = fakeRes();
  await webchatMessage(fakeReq({ conversationId: 'wc-empty1', message: '   ' }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.ok, false);
});

test('webchat: mensaje demasiado largo devuelve 400', async () => {
  const res = fakeRes();
  await webchatMessage(fakeReq({ conversationId: 'wc-long01', message: 'x'.repeat(2500) }), res);
  assert.equal(res.statusCode, 400);
});
