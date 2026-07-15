import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';

// Test de integración de M2: el endpoint Custom LLM de Vapi corre el MISMO motor (runConversation)
// con el perfil de voz, traduce OpenAI <-> Anthropic y ejecuta las tools de voz. Mockea Anthropic.
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

let impl: (args: any) => Promise<any> = async () => ({ content: [{ type: 'text', text: '' }], usage: {} });
const createCalls: any[] = [];

mock.module('../src/ai/client.ts', {
  namedExports: {
    anthropic: { messages: { create: (args: any) => (createCalls.push(args), impl(args)) } },
    REASONER: 'claude-test-sonnet',
    CLASSIFIER: 'claude-test-haiku',
  },
});

const { vapiChatCompletions } = await import('../src/routes/vapiLlm');
const { runConversation } = await import('../src/ai/agentLoop');
const { VOICE_PROFILE } = await import('../src/core/channel');

const textResp = (text: string) => ({ content: [{ type: 'text', text }], usage: {} });
const toolResp = (id: string, name: string, input: any) => ({ content: [{ type: 'tool_use', id, name, input }], usage: {} });

function fakeReq(body: any): Request {
  return { body, header: () => undefined } as unknown as Request;
}
function fakeRes() {
  const res: any = { statusCode: 200, headers: {} as Record<string, string>, body: undefined, sse: [] as string[], ended: false };
  res.setHeader = (k: string, v: string) => ((res.headers[k] = v), res);
  res.set = res.setHeader;
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: unknown) => ((res.body = b), (res.ended = true), res);
  res.write = (s: string) => (res.sse.push(String(s)), true);
  res.end = (s?: string) => (s ? res.sse.push(String(s)) : null, (res.ended = true), res);
  return res as Response & { statusCode: number; headers: any; body: any; sse: string[]; ended: boolean };
}

test('custom-llm: responde en formato OpenAI y usa el prompt de voz (no el system entrante)', async () => {
  createCalls.length = 0;
  impl = async () => textResp('Tenemos el MBA en modalidad online.');
  const res = fakeRes();
  await vapiChatCompletions(
    fakeReq({
      stream: false,
      call: { id: 'c-openai' },
      messages: [
        { role: 'system', content: 'PROMPT ENTRANTE QUE DEBE IGNORARSE' },
        { role: 'assistant', content: 'Hola, ¿en qué le ayudo?' },
        { role: 'user', content: 'quiero un MBA' },
      ],
    }),
    res,
  );
  assert.equal(res.body.object, 'chat.completion');
  assert.equal(res.body.choices[0].message.role, 'assistant');
  assert.equal(res.body.choices[0].message.content, 'Tenemos el MBA en modalidad online.');
  assert.equal(res.body.choices[0].finish_reason, 'stop');

  // El system que ve el modelo es el del PERFIL de voz, no el que mandó Vapi.
  assert.equal(createCalls[0].system, VOICE_PROFILE.systemPrompt);
  // La conversión dejó el primer mensaje como 'user' (descartó system y el saludo del asistente).
  assert.equal(createCalls[0].messages[0].role, 'user');
});

test('custom-llm: ejecuta una tool de voz (consultar_programas) y continúa', async () => {
  createCalls.length = 0;
  let step = 0;
  impl = async () => {
    step++;
    if (step === 1) return toolResp('t1', 'consultar_programas', { texto: 'MBA' });
    return textResp('Le cuento sobre el MBA.');
  };
  const res = fakeRes();
  await vapiChatCompletions(
    fakeReq({ stream: false, call: { id: 'c-tool' }, messages: [{ role: 'user', content: 'MBA?' }] }),
    res,
  );
  assert.equal(step, 2, 'el motor decide la tool y luego responde');
  assert.equal(res.body.choices[0].message.content, 'Le cuento sobre el MBA.');
  // El segundo prompt al modelo trae el tool_result de la ejecución de voz.
  const hasToolResult = createCalls[1].messages.some(
    (m: any) => Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_result'),
  );
  assert.ok(hasToolResult);
});

test('custom-llm: modo streaming emite SSE con el texto y [DONE]', async () => {
  impl = async () => textResp('Listo, lo anoto.');
  const res = fakeRes();
  await vapiChatCompletions(
    fakeReq({ stream: true, call: { id: 'c-sse' }, messages: [{ role: 'user', content: 'hola' }] }),
    res,
  );
  const joined = res.sse.join('');
  assert.match(res.headers['Content-Type'], /event-stream/);
  assert.ok(joined.includes('Listo, lo anoto.'), 'incluye el texto en un delta');
  assert.ok(joined.includes('[DONE]'), 'cierra el stream');
});

test('custom-llm: sin turno de usuario devuelve saludo sin invocar al modelo', async () => {
  createCalls.length = 0;
  let called = 0;
  impl = async () => (called++, textResp('no deberia'));
  const res = fakeRes();
  await vapiChatCompletions(fakeReq({ stream: false, call: { id: 'c-empty' }, messages: [] }), res);
  assert.equal(called, 0, 'no llama al modelo si no hay mensaje del usuario');
  assert.match(res.body.choices[0].message.content, /Postgrados/i);
});

test('runConversation: usa el ejecutor de tools INYECTADO (no el de chat)', async () => {
  let step = 0;
  impl = async () => {
    step++;
    if (step === 1) return toolResp('x1', 'mi_tool', { a: 1 });
    return textResp('hecho');
  };
  const llamadas: string[] = [];
  const execTool = async (name: string) => {
    llamadas.push(name);
    return { ok: true };
  };
  // Perfil con una tool ficticia habilitada para probar que el ejecutor inyectado es quien corre.
  const profile = { ...VOICE_PROFILE, toolNames: ['mi_tool'] };
  const { text } = await runConversation({ profile, auditId: 'rc-1' }, [{ role: 'user', content: 'hola' }], execTool);
  assert.equal(text, 'hecho');
  assert.deepEqual(llamadas, ['mi_tool'], 'el motor delegó en el ejecutor inyectado');
});
