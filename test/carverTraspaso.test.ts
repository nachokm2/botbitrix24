import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Punto de entrada de mensajes (routes/botEvents.ts) con el traspaso por sesión de Carver. Caso real
// del piloto (chat del 12-oct-2026): el bot derivó de madrugada, un asesor tomó el chat y conversó con
// el cliente, y 12 horas después el bot volvió a contestar en LA MISMA sesión de Open Lines —el
// estado que lo silenciaba vive 6 h—, hablando como ese asesor y nombrándolo en tercera persona.
process.env.MARCA = 'carver';
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.BITRIX_BOT_ID = '800185';

const llamadas: Array<{ method: string; params: any }> = [];
const crm = async (method: string, params: any) => {
  llamadas.push({ method, params });
  if (method === 'user.get') return []; // el remitente es el cliente, no un empleado
  return {};
};
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: crm,
    callCrm: crm,
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: [], total: 0, next: null }),
    callWebhook: async () => ({}),
  },
});
const auditorias: any[] = [];
mock.module('../src/obs/audit.ts', { namedExports: { audit: async (e: any) => void auditorias.push(e) } });
let turnos = 0;
mock.module('../src/ai/agentLoop.ts', {
  namedExports: {
    runAgentTurn: async () => {
      turnos++;
      return 'respuesta del bot';
    },
  },
});
mock.module('../src/ai/scoring.ts', { namedExports: { procesarScoring: async () => {} } });

const { botMessageHandler } = await import('../src/routes/botEvents');
const { marcarTraspaso } = await import('../src/session');

const evento = (msgId: number, sesion: string) => ({
  body: {
    event: 'ONIMBOTMESSAGEADD',
    auth: { access_token: 'tok', domain: 'test.bitrix24.com' },
    data: {
      BOT: { 800185: {} },
      PARAMS: {
        DIALOG_ID: 'chat1501721',
        CHAT_ID: '1501721',
        MESSAGE: 'Me puede llamar alguien?',
        MESSAGE_ID: msgId,
        FROM_USER_ID: '767389',
        CHAT_ENTITY_TYPE: 'LINES',
        CHAT_ENTITY_DATA_1: `Y|DEAL|3482325|N|N|${sesion}|1791755708|0|0|0`,
        CHAT_ENTITY_DATA_2: 'LEAD|0|COMPANY|0|CONTACT|3029427|DEAL|3482325',
      },
    },
  },
  query: {},
});
const res = { status: () => ({ json: () => {} }) } as any;
const esperar = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
};

test('con la sesión traspasada a una persona, el bot NO responde, aunque hayan pasado más de 6 h', async () => {
  await marcarTraspaso('chat1501721', '1233711', 'escalado');
  botMessageHandler(evento(1, '1233711') as any, res);
  await esperar(() => auditorias.some((a) => a.type === 'bot_en_silencio'));
  assert.equal(turnos, 0, 'no corrió el motor');
  assert.equal(llamadas.filter((c) => c.method === 'imbot.message.add').length, 0, 'no envió nada al cliente');
  assert.ok(auditorias.some((a) => a.type === 'bot_en_silencio' && a.detail.motivo === 'escalado'));
});

test('en una sesión NUEVA de Open Lines, el bot vuelve a atender', async () => {
  botMessageHandler(evento(2, '1299999') as any, res);
  await esperar(() => turnos > 0 && llamadas.some((c) => c.method === 'imbot.message.add'));
  assert.equal(turnos, 1);
  assert.equal(llamadas.filter((c) => c.method === 'imbot.message.add').length, 1);
});
