import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Regresión del hallazgo 11 (auditoría de Carver, oct-2026): "Por tu interés, te conecto con un
// asesor…" llegó CUATRO veces a un mismo cliente. La autoescalada por score enviaba el mensaje y
// recién después intentaba el traspaso; Bitrix lo rechazaba ("Operator is not a bot": ya atendía
// una persona), la marca de "ya escalado" nunca se guardaba y el mensaje se repetía en cada turno.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.SCORE_ESCALAR = '80';

const llamadas: Array<{ method: string; params: any }> = [];
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: async (method: string, params: any) => {
      llamadas.push({ method, params });
      if (method === 'imopenlines.bot.session.operator') throw new Error('Bitrix imopenlines.bot.session.operator: WRONG_CHAT Operator is not a bot');
      return {};
    },
    callCrm: async () => ({}),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: {} }),
    callWebhook: async () => ({}),
  },
});
mock.module('../src/obs/audit.ts', { namedExports: { audit: async () => {} } });
mock.module('../src/ai/client.ts', {
  namedExports: {
    anthropic: {
      messages: {
        create: async () => ({
          content: [{ type: 'text', text: '{"score": 92, "intencion": "alta", "sentimiento": "positivo", "justificacion": "quiere matricularse"}' }],
          usage: {},
        }),
      },
    },
    REASONER: 'x',
    CLASSIFIER: 'y',
  },
});

const { procesarScoring } = await import('../src/ai/scoring');
const { setHistory } = await import('../src/ai/memory');
const { getSession, saveSession } = await import('../src/session');
const auth = { domain: 't', access_token: 't' } as any;

test('con el traspaso rechazado, el mensaje de autoescalada sale UNA sola vez aunque el score siga alto', async () => {
  const dialogId = 'chat-autoescala';
  await setHistory(dialogId, [
    { role: 'user', content: 'Quiero matricularme ya en la maestría' },
    { role: 'assistant', content: 'Excelente decisión.' },
  ]);
  for (let turno = 0; turno < 4; turno++) {
    await procesarScoring({ dialogId, chatId: 123, botId: 1, crmEntities: {}, auth });
    // Simula que el estado de la sesión venció entre turnos (vive 6 h): no debe bastar para repetir.
    if (turno === 1) await saveSession(dialogId, {});
  }
  const mensajes = llamadas.filter((c) => c.method === 'imbot.message.add');
  assert.equal(mensajes.length, 1, `se envió ${mensajes.length} veces`);
});

test('"Operator is not a bot" se interpreta como que ya atiende una persona: el bot queda en silencio', async () => {
  const dialogId = 'chat-ya-atendido';
  await setHistory(dialogId, [
    { role: 'user', content: 'Quiero matricularme ya en la maestría' },
    { role: 'assistant', content: 'Excelente decisión.' },
  ]);
  await procesarScoring({ dialogId, chatId: 124, botId: 1, crmEntities: {}, auth });
  const s = await getSession(dialogId);
  assert.equal(s.humanTookOver, true);
  assert.equal(s.escalatedByScore, true);
});
