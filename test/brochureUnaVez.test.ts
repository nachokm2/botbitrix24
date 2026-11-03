import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Punto 6 del feedback de admisión de Carver (02-11-2026): el bot manda el brochure sin esperar a
// que lo pidan. Como lo decide el modelo, sin un tope lo mandaría cada vez que se vuelve a hablar
// del programa: va una vez por programa y conversación, salvo que la persona lo pida de nuevo.
process.env.MARCA = 'carver';
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: async () => ({}),
    callCrm: async () => ({}),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: [], total: 0, next: null }),
    callWebhook: async () => ({}),
  },
});
mock.module('../src/obs/audit.ts', { namedExports: { audit: async () => {} } });

// La verificación del enlace del brochure sale a la red: acá responde un PDF válido.
globalThis.fetch = (async () => ({
  status: 200,
  headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/pdf' : null) },
  arrayBuffer: async () => Buffer.from('%PDF-1.7 ...'),
  text: async () => '',
})) as any;

const { executeTool, pideElBrochure } = await import('../src/ai/toolRunner');
const { WHATSAPP_PROFILE } = await import('../src/core/channel');

const ctx = (ultimoMensajeCliente: string, conversationId = 'chat-brochure') =>
  ({
    profile: WHATSAPP_PROFILE,
    auth: { domain: 'test.bitrix24.com', access_token: 'tok' },
    conversationId,
    crmEntities: {},
    chatId: '123',
    ultimoMensajeCliente,
  }) as any;

test('brochure: la primera vez se entrega; la segunda, en la misma conversación, no', async () => {
  const id = 'chat-una-vez';
  const a: any = await executeTool('obtener_brochure', { programa: 'Maestría en Psicología' }, ctx('¿Cuánto dura?', id));
  assert.equal(a.ok, true);
  assert.ok(a.url, 'la primera vez trae el enlace');
  const b: any = await executeTool('obtener_brochure', { programa: 'Maestría en Psicología' }, ctx('¿Y los requisitos?', id));
  assert.equal(b.yaEnviado, true);
  assert.equal(b.url, undefined, 'no vuelve a entregar el enlace');
  assert.match(b.nota, /NO lo vuelvas a enviar/);
});

test('brochure: si la persona lo pide otra vez (o no le llegó), se reenvía', async () => {
  const id = 'chat-reenvio';
  await executeTool('obtener_brochure', { programa: 'Maestría en Psicología' }, ctx('Hola', id));
  const r: any = await executeTool('obtener_brochure', { programa: 'Maestría en Psicología' }, ctx('No me llegó el PDF', id));
  assert.equal(r.yaEnviado, undefined);
  assert.ok(r.url);
});

test('brochure: el tope es por programa, no por conversación', async () => {
  const id = 'chat-dos-programas';
  await executeTool('obtener_brochure', { programa: 'Maestría en Psicología' }, ctx('Hola', id));
  const r: any = await executeTool('obtener_brochure', { programa: 'Maestría en Inteligencia Artificial' }, ctx('¿Y la de IA?', id));
  assert.equal(r.yaEnviado, undefined);
});

test('pideElBrochure: distingue un pedido de una mención', () => {
  for (const t of [
    '¿Me puede enviar el brochure?',
    'tienen el programa en pdf?',
    'Quisiera el folleto',
    'No me llegó nada',
    '¿Me lo reenvía?',
    'no lo encuentro',
    'mándemelo de nuevo por favor',
  ]) assert.equal(pideElBrochure(t), true, t);
  for (const t of ['Gracias por el brochure', 'Ya lo leí', '¿Cuánto cuesta?', 'Sí, me interesa']) {
    assert.equal(pideElBrochure(t), false, t);
  }
});

test('prompt de Carver: el brochure se manda sin que lo pidan y el valor no va de entrada', () => {
  const p = WHATSAPP_PROFILE.systemPrompt;
  assert.match(p, /envíale el brochure con "obtener_brochure" en ese MISMO turno, sin preguntarle/);
  assert.match(p, /El valor NO va en esa primera respuesta si no lo pidió/);
  assert.match(p, /Va en DOS pasos para que el mensaje sea corto/);
  assert.match(p, /no más de unos 350 caracteres/);
  assert.doesNotMatch(p, /Preséntalas juntas/);
});
