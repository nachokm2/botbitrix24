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
// El horario de asesores se prueba aparte (horarioAsesores.test.ts). Acá se desactiva para que
// estas pruebas no dependan de la hora a la que se ejecuten.
process.env.HORARIO_ASESORES_ACTIVO = 'false';

const llamadas: Array<{ method: string; params: any }> = [];
/** Quien responde a user.get. Vacio = el remitente es el cliente, no un empleado del portal. */
let usuarioDelPortal: any[] = [];
/** Participantes del chat de Open Lines. Por defecto solo el bot y el cliente (que entra como
 *  externo): nadie recogió la conversación. */
let participantes: any[] = [
  { id: 800185, bot: true, name: 'Carver University' },
  { id: 767389, extranet: true, name: 'cliente' },
];
const crm = async (method: string, params: any) => {
  llamadas.push({ method, params });
  if (method === 'user.get') return usuarioDelPortal;
  if (method === 'im.dialog.users.list') return participantes;
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

// ── El asesor escribe PRIMERO ────────────────────────────────────────────────────────────────────
// Es lo habitual cuando toma un lead: saluda el. Antes el bot solo ignoraba ese mensaje sin anotar
// que habia alguien atendiendo, asi que volvia a meterse apenas el cliente contestaba.
const eventoDe = (msgId: number, sesion: string, fromUser: string, dialogo: string) => {
  const e: any = evento(msgId, sesion);
  e.body.data.PARAMS.FROM_USER_ID = fromUser;
  e.body.data.PARAMS.DIALOG_ID = dialogo;
  e.body.data.PARAMS.MESSAGE = 'Hola, soy su asesor, lo acompano con su postulacion';
  return e;
};

test('si el asesor escribe primero, el bot se retira y NO contesta al cliente', async () => {
  usuarioDelPortal = [{ ID: '479681', NAME: 'Yhoselin', LAST_NAME: 'Vilca', EMAIL: 'y@carver.university', ACTIVE: true, UF_DEPARTMENT: [193] }];
  turnos = 0;
  llamadas.length = 0;
  auditorias.length = 0;

  botMessageHandler(eventoDe(10, '1300001', '479681', 'chat-asesor-primero') as any, res);
  await esperar(() => auditorias.some((a) => a.type === 'operator_msg'));
  assert.ok(auditorias.some((a) => a.type === 'operator_msg' && a.detail.asesorDelEquipo === true));

  // Ahora contesta el cliente: el bot ya no debe meterse.
  usuarioDelPortal = [];
  botMessageHandler(eventoDe(11, '1300001', '767389', 'chat-asesor-primero') as any, res);
  await esperar(() => auditorias.some((a) => a.type === 'bot_en_silencio'));
  assert.equal(turnos, 0, 'el motor no corrio');
  assert.equal(llamadas.filter((c) => c.method === 'imbot.message.add').length, 0, 'no le escribio al cliente');
});

test('un mensaje del usuario del webhook NO cuenta como asesor atendiendo', async () => {
  // Si cualquier empleado callara al bot, un mensaje automatico lo dejaria mudo sin que nadie haya
  // tomado el caso. Solo cuenta un asesor valido del equipo.
  usuarioDelPortal = [{ ID: '4173', NAME: 'Webhook', LAST_NAME: 'Admin', EMAIL: 'admin@uautonoma.cl', ACTIVE: true, UF_DEPARTMENT: [7] }];
  turnos = 0;
  llamadas.length = 0;
  auditorias.length = 0;

  botMessageHandler(eventoDe(20, '1300002', '4173', 'chat-webhook-primero') as any, res);
  await esperar(() => auditorias.some((a) => a.type === 'operator_msg'));
  assert.ok(auditorias.some((a) => a.type === 'operator_msg' && a.detail.asesorDelEquipo === false));

  usuarioDelPortal = [];
  botMessageHandler(eventoDe(21, '1300002', '767389', 'chat-webhook-primero') as any, res);
  await esperar(() => turnos > 0);
  assert.equal(turnos, 1, 'el bot sigue atendiendo: nadie tomo el caso de verdad');
});

// ── Una persona recoge la conversación desde Bitrix ──────────────────────────────────────────────
// Caso real, deal #3649251 del 15-oct-2026: la asesora se unió al chat a las 13:11, lo recogió a las
// 13:12 y escribió a las 13:13. A las 13:35 el cliente respondió y el bot contestó por encima.
// Bitrix NO le entrega al bot los mensajes de los operadores, así que entre su último turno y el del
// cliente, para el bot no había pasado nada. Lo que sí puede ver es quién está dentro del chat.
test('si una persona está dentro del chat, el bot NO responde aunque nunca haya visto su mensaje', async () => {
  const { _limpiarCacheOperadores } = await import('../src/crm/operadorEnChat');
  _limpiarCacheOperadores();
  turnos = 0;
  llamadas.length = 0;
  auditorias.length = 0;
  participantes = [
    { id: 800185, bot: true, name: 'Carver University' },
    { id: 767389, extranet: true, name: 'cliente' },
    { id: 536133, name: 'Valezka Hernández' }, // se unió y recogió la conversación
  ];

  botMessageHandler(eventoDe(30, '1400001', '767389', 'chat-con-operador') as any, res);
  await esperar(() => auditorias.some((a) => a.type === 'operator_msg'));
  assert.ok(auditorias.some((a) => a.type === 'operator_msg' && a.detail.motivo === 'operador_en_el_chat'));
  assert.equal(turnos, 0, 'el motor no corrió');
  assert.equal(llamadas.filter((c) => c.method === 'imbot.message.add').length, 0, 'no le escribió al cliente');

  participantes = participantes.slice(0, 2);
  _limpiarCacheOperadores();
});

test('con solo el bot y el cliente en el chat, el bot atiende normalmente', async () => {
  const { _limpiarCacheOperadores } = await import('../src/crm/operadorEnChat');
  _limpiarCacheOperadores();
  turnos = 0;
  llamadas.length = 0;
  participantes = [
    { id: 800185, bot: true, name: 'Carver University' },
    { id: 767389, extranet: true, name: 'cliente' },
  ];
  botMessageHandler(eventoDe(31, '1400002', '767389', 'chat-sin-operador') as any, res);
  await esperar(() => turnos > 0);
  assert.equal(turnos, 1);
  _limpiarCacheOperadores();
});

test('si Bitrix no responde la lista de participantes, el bot atiende igual', async () => {
  // Fail-open a propósito: dejar mudo al bot por una consulta fallida es peor que una respuesta de
  // más, porque el cliente se queda esperando a nadie.
  const { hayOperadorEnElChat, _limpiarCacheOperadores } = await import('../src/crm/operadorEnChat');
  _limpiarCacheOperadores();
  const original = participantes;
  participantes = null as any;
  assert.equal(await hayOperadorEnElChat('1400003', { domain: 'x', access_token: 'y' } as any), false);
  participantes = original;
  _limpiarCacheOperadores();
});

// ── Horario de asesores: callar NO basta ─────────────────────────────────────────────────────────
// El canal quedó configurado con "No transferir" (WELCOME_BOT_TIME 0), así que si el bot recibe la
// conversación y no hace nada, nadie la recibe después: la persona espera para siempre. Antes había
// un respaldo de 600 segundos; ya no.
test('en horario de asesores el bot ENTREGA la sesión a la cola, no solo calla', async () => {
  const { config } = await import('../src/config');
  const antes = { act: config.horarioAsesoresActivo, ini: config.horarioAsesoresInicio, fin: config.horarioAsesoresFin, dias: config.horarioAsesoresDias };
  // Se fuerza "siempre hay asesores" para que la prueba no dependa de la hora en que se ejecute.
  config.horarioAsesoresActivo = true;
  config.horarioAsesoresInicio = '00:00';
  config.horarioAsesoresFin = '24:00';
  config.horarioAsesoresDias = [0, 1, 2, 3, 4, 5, 6];
  turnos = 0;
  llamadas.length = 0;
  auditorias.length = 0;

  botMessageHandler(eventoDe(40, '1500001', '767389', 'chat-horario') as any, res);
  await esperar(() => auditorias.some((a) => a.type === 'bot_en_silencio'));

  assert.equal(turnos, 0, 'el bot no responde');
  assert.equal(llamadas.filter((c) => c.method === 'imbot.message.add').length, 0, 'no le escribe al cliente');
  const entrega = llamadas.find((c) => c.method === 'imopenlines.bot.session.operator');
  assert.ok(entrega, 'entrega la sesión a la cola para que la tome un asesor');
  const a = auditorias.find((x) => x.type === 'bot_en_silencio' && x.detail.motivo === 'horario_asesores');
  assert.ok(a, 'queda auditado');
  assert.equal(a.detail.entregada, true);

  Object.assign(config, { horarioAsesoresActivo: antes.act, horarioAsesoresInicio: antes.ini, horarioAsesoresFin: antes.fin, horarioAsesoresDias: antes.dias });
});
