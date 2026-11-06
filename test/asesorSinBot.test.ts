import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Asesores que atienden sus negociaciones sin el bot (crm/asesorSinBot.ts): si es el responsable, el bot
// no le escribe a ese cliente y le entrega el chat, para que el mensaje no quede sin nadie que lo lea.
process.env.MARCA = 'carver';
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.BITRIX_BOT_ID = '800185';
process.env.HORARIO_ASESORES_ACTIVO = 'false';
process.env.ASESORES_SIN_BOT = '777';
process.env.EMBUDOS_PROPIOS = '';

const llamadas: Array<{ method: string; params: any }> = [];
let ficha: any = {};
let fallaCrm = false;
let fallaTraspaso = false;
const crm = async (method: string, params: any) => {
  llamadas.push({ method, params });
  if (/^crm\.(deal|lead|contact)\.get$/.test(method)) {
    if (fallaCrm) throw new Error('OVERLOAD_LIMIT');
    return ficha;
  }
  if (method === 'imopenlines.bot.session.transfer' && fallaTraspaso) throw new Error('OPERATOR_WRONG');
  if (method === 'user.get') return [];
  if (method === 'im.dialog.users.list') return [{ id: 800185, bot: true, name: 'Carver University' }, { id: 767389, extranet: true, name: 'cliente' }];
  if (method === 'im.dialog.get') return { entity_id: '' };
  if (method === 'imopenlines.dialog.get') return { entity_data_2: 'LEAD|0|COMPANY|0|CONTACT|3029427|DEAL|3482325' };
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

const { asesorSinBotACargo, esAsesorSinBot } = await import('../src/crm/asesorSinBot');
const { botMessageHandler } = await import('../src/routes/botEvents');
const { traspasoVigente } = await import('../src/session');
const { setInstallAuth } = await import('../src/store');
await setInstallAuth?.({ access_token: 'tok', domain: 'test.bitrix24.com' } as any);

const AUTH: any = { access_token: 'tok', domain: 'test.bitrix24.com' };
const evento = (msgId: number, chat: string) => ({
  body: {
    event: 'ONIMBOTMESSAGEADD',
    auth: AUTH,
    data: {
      BOT: { 800185: {} },
      PARAMS: {
        DIALOG_ID: `chat${chat}`,
        CHAT_ID: chat,
        MESSAGE: 'Hola, quiero saber el precio',
        MESSAGE_ID: msgId,
        FROM_USER_ID: '767389',
        CHAT_ENTITY_TYPE: 'LINES',
        CHAT_ENTITY_DATA_1: 'Y|DEAL|3482325|N|N|1233711|1791755708|0|0|0',
        CHAT_ENTITY_DATA_2: 'LEAD|0|COMPANY|0|CONTACT|3029427|DEAL|3482325',
      },
    },
  },
  query: {},
});
const res = { status: () => ({ json: () => {} }) } as any;
const esperar = async (cond: () => boolean) => {
  for (let i = 0; i < 150 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
};
const silencios = () => auditorias.filter((a) => a.type === 'bot_en_silencio' && a.detail?.motivo === 'asesor_sin_bot');
const enviados = () => llamadas.filter((c) => c.method === 'imbot.message.add');

test('se reconoce por el responsable de la negociación, y si no hay negociación, por el del lead o el contacto', async () => {
  ficha = { ASSIGNED_BY_ID: '777' };
  assert.equal(await asesorSinBotACargo({ deal: 1, contact: 2 }, AUTH), 777);
  assert.equal(llamadas.at(-1)?.method, 'crm.deal.get');
  assert.equal(await asesorSinBotACargo({ lead: 3 }, AUTH), 777);
  assert.equal(llamadas.at(-1)?.method, 'crm.lead.get');
  assert.equal(await asesorSinBotACargo({ contact: 2 }, AUTH), 777);
  assert.equal(llamadas.at(-1)?.method, 'crm.contact.get');

  ficha = { ASSIGNED_BY_ID: '166867' };
  assert.equal(await asesorSinBotACargo({ deal: 1 }, AUTH), null, 'otro asesor: el bot atiende');
  assert.equal(await asesorSinBotACargo(null, AUTH), null);
  assert.equal(esAsesorSinBot('777'), true);
  assert.equal(esAsesorSinBot(undefined), false);
});

test('si Bitrix no responde, el bot atiende: callar dejaría sin respuesta a todos los clientes', async () => {
  fallaCrm = true;
  assert.equal(await asesorSinBotACargo({ deal: 1 }, AUTH), null);
  fallaCrm = false;
});

test('el responsable atiende sin el bot: no corre el motor, no se escribe nada y el chat se le entrega a él', async () => {
  ficha = { ASSIGNED_BY_ID: '777' };
  turnos = 0;
  botMessageHandler(evento(1, '900001') as any, res);
  await esperar(() => silencios().length === 1);
  assert.equal(turnos, 0, 'no corrió el motor');
  assert.equal(enviados().length, 0, 'no le escribió al cliente');
  const traspaso = llamadas.find((c) => c.method === 'imopenlines.bot.session.transfer');
  assert.equal(traspaso?.params.USER_ID, 777);
  assert.equal(silencios()[0].detail.entregada, 'persona');
  assert.equal((await traspasoVigente('chat900001', '1233711'))?.motivo, 'asesor_sin_bot');
});

test('si Bitrix no acepta el traspaso al asesor, el chat va a la cola y el bot igual calla', async () => {
  ficha = { ASSIGNED_BY_ID: '777' };
  fallaTraspaso = true;
  auditorias.length = 0;
  llamadas.length = 0;
  turnos = 0;
  botMessageHandler(evento(2, '900002') as any, res);
  await esperar(() => silencios().length === 1);
  fallaTraspaso = false;
  assert.equal(turnos, 0);
  assert.equal(enviados().length, 0);
  assert.ok(llamadas.some((c) => c.method === 'imopenlines.bot.session.operator'));
  assert.equal(silencios()[0].detail.entregada, 'cola');
});

test('el barrido de chats tampoco lo toca: no retoma, no rearma recordatorios ni avisa que el cliente espera', async () => {
  const { retomarChat } = await import('../src/ai/retomarChat');
  ficha = { ASSIGNED_BY_ID: '777' };
  llamadas.length = 0;
  const r = await retomarChat('chat900009');
  assert.equal(r.retomado, false);
  assert.equal(r.motivo, 'asesor_sin_bot');
  assert.ok(!llamadas.some((c) => c.method === 'im.notify.personal.add'), 'sin avisos');
  assert.ok(!llamadas.some((c) => c.method === 'im.dialog.messages.get'), 'ni siquiera lee el chat');
  assert.equal(enviados().length, 0);
});

test('con otro responsable, el bot atiende como siempre', async () => {
  ficha = { ASSIGNED_BY_ID: '166867' };
  auditorias.length = 0;
  llamadas.length = 0;
  turnos = 0;
  botMessageHandler(evento(3, '900003') as any, res);
  await esperar(() => enviados().length === 1);
  assert.equal(turnos, 1);
  assert.equal(silencios().length, 0);
  assert.ok(!llamadas.some((c) => c.method === 'imopenlines.bot.session.transfer'));
});
