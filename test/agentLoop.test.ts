import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Test de integración del bucle del agente (runAgentTurn): razonamiento + tool-calling + memoria.
// Mockea SOLO el cliente Anthropic (../src/ai/client) para no tocar la red; el resto corre real:
// el registro de tools, executeTool (catálogo estático), memoria en Redis-modo-memoria, métricas.
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

// `impl` es la implementación programable de anthropic.messages.create para cada test.
let impl: (args: any) => Promise<any> = async () => ({ content: [{ type: 'text', text: '' }], usage: {} });

mock.module('../src/ai/client.ts', {
  namedExports: {
    anthropic: { messages: { create: (args: any) => impl(args) } },
    REASONER: 'claude-test-sonnet',
    CLASSIFIER: 'claude-test-haiku',
  },
});

const { runAgentTurn } = await import('../src/ai/agentLoop');
const { getHistory } = await import('../src/ai/memory');

const ctx = () => ({ auth: { domain: '', access_token: '' }, dialogId: '', botId: 1, crmEntities: {}, crmEntity: null }) as any;

const textResp = (text: string) => ({ content: [{ type: 'text', text }], usage: { input_tokens: 5, output_tokens: 7 } });
const toolResp = (id: string, name: string, input: any) => ({ content: [{ type: 'tool_use', id, name, input }], usage: {} });

test('runAgentTurn: respuesta de solo texto se devuelve y se guarda en memoria', async () => {
  impl = async () => textResp('¡Hola! ¿En qué puedo ayudarte con nuestros postgrados?');
  const c = { ...ctx(), dialogId: 'al-text' };
  const reply = await runAgentTurn(c, 'hola');
  assert.equal(reply, '¡Hola! ¿En qué puedo ayudarte con nuestros postgrados?');
  const hist = await getHistory('al-text');
  assert.ok(hist.length >= 2, 'guarda el turno del usuario y del asistente en la memoria');
});

test('runAgentTurn: ejecuta una tool real (consultar_programas) y continúa con la respuesta', async () => {
  const seen: any[] = [];
  let step = 0;
  impl = async (args: any) => {
    seen.push(args);
    step++;
    if (step === 1) return toolResp('tu1', 'consultar_programas', { tipo: 'magister', texto: 'MBA' });
    return textResp('Tenemos el MBA en modalidad online y presencial.');
  };
  const reply = await runAgentTurn({ ...ctx(), dialogId: 'al-tool' }, 'quiero un MBA');
  assert.equal(reply, 'Tenemos el MBA en modalidad online y presencial.');
  assert.equal(step, 2, 'llama al modelo 2 veces: decide la tool y luego responde');
  // El segundo prompt al modelo debe incluir el tool_result de la ejecución real.
  const secondCallMsgs = seen[1].messages;
  const hasToolResult = secondCallMsgs.some(
    (m: any) => Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_result'),
  );
  assert.ok(hasToolResult, 'el resultado de la tool se realimenta al modelo');
});

test('runAgentTurn: guardrail anti-bucle corta a los 5 pasos y deriva', async () => {
  let step = 0;
  impl = async () => {
    step++;
    return toolResp('tu' + step, 'consultar_programas', { tipo: 'diplomado' }); // nunca devuelve texto
  };
  const reply = await runAgentTurn({ ...ctx(), dialogId: 'al-loop' }, 'dame info');
  assert.equal(step, 5, 'respeta el tope de MAX_STEPS');
  assert.match(reply, /asesor/i, 'cae al mensaje de derivación');
});

test('runAgentTurn: error del modelo devuelve mensaje de fallback (no revienta)', async () => {
  impl = async () => {
    throw new Error('boom de la API');
  };
  const reply = await runAgentTurn({ ...ctx(), dialogId: 'al-error' }, 'hola');
  assert.match(reply, /inconveniente técnico/i);
});
