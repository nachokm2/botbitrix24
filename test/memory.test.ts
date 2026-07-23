import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

const { getHistory, setHistory } = await import('../src/ai/memory');
const { setJson } = await import('../src/store/kv');

// Reproduce el 400 visto en producción: un slice ciego a los últimos N mensajes puede cortar
// justo entre un tool_use (assistant) y su tool_result (user) — Anthropic rechaza ese historial
// porque el primer mensaje no puede ser 'assistant' ni un tool_result sin su tool_use previo.
test('setHistory/getHistory: nunca deja un tool_result huérfano ni un turno assistant al inicio', async () => {
  const filler = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `relleno ${i}`,
    }));

  const messages = [
    ...filler(6), // 3 turnos previos (se recortan)
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'resultado' }] }, // huérfano tras el corte
    { role: 'assistant', content: [{ type: 'text', text: 'respuesta final del paso anterior' }] }, // también inválido como inicio
    { role: 'user', content: 'nueva pregunta del cliente' }, // primer turno realmente "limpio"
    ...filler(22), // suficientes mensajes para que el slice(-24) caiga en medio del par de arriba
  ];

  const dialogId = 'test-dialog-trim';
  await setHistory(dialogId, messages);
  const saved = await getHistory(dialogId);

  assert.equal(saved[0].role, 'user');
  assert.equal(saved[0].content, 'nueva pregunta del cliente');
  assert.ok(
    saved.every((m) => !(Array.isArray(m.content) && m.content.every((b: any) => b?.type === 'tool_result'))),
  );
});

test('getHistory: autorrepara un historial que ya quedó corrompido en KV (guardado antes del fix)', async () => {
  const dialogId = 'test-dialog-ya-corrompido';
  // Escribe directo en KV (bypass de setHistory) simulando lo que el bug viejo dejó guardado.
  await setJson(`mem:${dialogId}`, [
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'resultado' }] },
    { role: 'assistant', content: 'respuesta final del paso anterior' },
    { role: 'user', content: 'nueva pregunta del cliente' },
  ]);

  const saved = await getHistory(dialogId);
  assert.equal(saved[0].role, 'user');
  assert.equal(saved[0].content, 'nueva pregunta del cliente');
});

test('setHistory/getHistory: conversación corta (sin necesidad de recorte) queda intacta', async () => {
  const messages = [
    { role: 'user', content: 'hola' },
    { role: 'assistant', content: 'hola, ¿en qué te ayudo?' },
  ];
  const dialogId = 'test-dialog-short';
  await setHistory(dialogId, messages);
  const saved = await getHistory(dialogId);
  assert.deepEqual(saved, messages);
});
