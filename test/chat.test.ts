import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// loadPriorContext: además de las notas de conversaciones anteriores, debe incluir el "programa de
// interés" YA REGISTRADO en el Deal (p. ej. un deal creado por una campaña de marketing, ANTES de que
// el cliente escriba nada por chat) — bug real que motivó esto: deal #3491489 (Diego Carvajal) llegó
// desde una campaña con "Diplomado en Inteligencia Artificial" ya en el UF, y el bot igual le preguntó
// desde cero "¿qué programa te interesa?" porque loadPriorContext solo miraba notas de timeline.
process.env.REDIS_URL = '';
process.env.NODE_ENV = 'test';
process.env.BITRIX_UF_PROGRAMA = 'UF_CRM_PROGRAMA_TEST';

const calls: { method: string; params: any }[] = [];
let responder: (method: string, params: any) => any = () => ({});
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: async (m: string, p: any) => (calls.push({ method: m, params: p }), responder(m, p)),
    callCrm: async (m: string, p: any) => (calls.push({ method: m, params: p }), responder(m, p)),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: {} }),
    callWebhook: async () => ({}),
  },
});

const { loadPriorContext } = await import('../src/crm/chat');
const auth = { domain: '', access_token: '' } as any;

test('loadPriorContext: deal con programa ya registrado en el UF → lo incluye como dato real', async () => {
  calls.length = 0;
  responder = (method) => {
    if (method === 'crm.deal.get') return { UF_CRM_PROGRAMA_TEST: 'Diplomado en Inteligencia Artificial' };
    if (method === 'crm.timeline.comment.list') return [];
    return {};
  };
  const ctx = await loadPriorContext({ type: 'deal', id: 3491489 }, auth);
  assert.match(ctx, /Diplomado en Inteligencia Artificial/);
  assert.match(ctx, /YA REGISTRADO/);
});

test('loadPriorContext: deal sin programa y sin notas previas → string vacío', async () => {
  calls.length = 0;
  responder = (method) => {
    if (method === 'crm.deal.get') return {};
    if (method === 'crm.timeline.comment.list') return [];
    return {};
  };
  const ctx = await loadPriorContext({ type: 'deal', id: 1 }, auth);
  assert.equal(ctx, '');
});

test('loadPriorContext: un LEAD no tiene UF de programa → no intenta leerlo, solo usa notas', async () => {
  calls.length = 0;
  responder = (method) => {
    if (method === 'crm.timeline.comment.list') return [{ COMMENT: 'Conversación IA: hola' }];
    return {};
  };
  const ctx = await loadPriorContext({ type: 'lead', id: 5 }, auth);
  assert.ok(!calls.find((c) => c.method === 'crm.deal.get'), 'no llama a crm.deal.get para un lead');
  assert.match(ctx, /hola/);
});

test('loadPriorContext: combina programa registrado + notas previas', async () => {
  calls.length = 0;
  responder = (method) => {
    if (method === 'crm.deal.get') return { UF_CRM_PROGRAMA_TEST: 'Magíster en Inteligencia Artificial' };
    if (method === 'crm.timeline.comment.list') return [{ COMMENT: 'Conversación IA: preguntó por becas' }];
    return {};
  };
  const ctx = await loadPriorContext({ type: 'deal', id: 42 }, auth);
  assert.match(ctx, /Magíster en Inteligencia Artificial/);
  assert.match(ctx, /preguntó por becas/);
});
