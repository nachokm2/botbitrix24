import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// 19-11-2026: la CAPI de Carver (robot en «Pendiente de Firma» con el leadgen_id del formulario) no ve los
// chats de WhatsApp de India. El bot le avisa a Meta directo: SubmitApplication cuando la persona pidió
// matricularse y recibió el enlace de pago; Purchase cuando el equipo confirma el pago («pagó 3770947»).
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.MARCA = 'carver';
process.env.INTERNACIONAL_PREFIJOS = '+91';
process.env.INTERNACIONAL_AVISAR_A = '4173';

const llamadasCrm: Array<{ method: string; params: any }> = [];
const privados: string[] = [];
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: async (method: string, params: any) => {
      if (method === 'imbot.message.add') privados.push(String(params.MESSAGE));
      return 1;
    },
    callCrm: async (method: string, params: any) => {
      llamadasCrm.push({ method, params });
      if (method === 'crm.deal.get') return Number(params.id) === 404 ? null : { ID: String(params.id), CONTACT_ID: '77', TITLE: 'Applied AI & Automation – Saleem' };
      if (method === 'crm.contact.get') return { PHONE: [{ VALUE: '+91 98765-43210' }], EMAIL: [{ VALUE: ' Saleem@Example.com ' }] };
      return {};
    },
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: [], total: 0, next: null }),
    callWebhook: async () => ({}),
  },
});

let respuestaClasificador = 'NO';
const pedidosAlModelo: any[] = [];
mock.module('../src/ai/client.ts', {
  namedExports: {
    anthropic: {
      messages: {
        create: async (req: any) => {
          pedidosAlModelo.push(req);
          return { content: [{ type: 'text', text: respuestaClasificador }], usage: {} };
        },
      },
    },
    REASONER: 'modelo-de-prueba',
    CLASSIFIER: 'clasificador-de-prueba',
  },
});

let filasPiloto: any[] | null = [];
const auditados: any[] = [];
// Sin base en la prueba: se reemplazan solo las dos funciones que importan aquí; el resto queda como es.
const dbReal = await import('../src/store/db.ts');
mock.module('../src/store/db.ts', {
  namedExports: {
    ...dbReal,
    dbEventosInternacionales: async () => filasPiloto,
    dbInsertAudit: async (e: any) => {
      auditados.push(e);
    },
  },
});

type Pedido = { url: string; body: any };
const aMeta: Pedido[] = [];
let respuestaMeta: { status: number; json: any } = { status: 200, json: { events_received: 1, fbtrace_id: 'x' } };
const fetchOriginal = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any) => {
  aMeta.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
  return { ok: respuestaMeta.status < 300, status: respuestaMeta.status, json: async () => respuestaMeta.json } as any;
}) as any;

const M = await import('../src/core/conversionesMeta');
const A = await import('../src/ai/asistenteEquipo');
const auth = { domain: 'test.bitrix24.com', access_token: 'x' } as any;
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

const configurar = () => {
  process.env.META_CAPI_DATASET_ID = '1234567890';
  process.env.META_CAPI_TOKEN = 'token-de-prueba';
  delete process.env.META_CAPI_TEST_CODE;
};

test('el teléfono y el correo se normalizan como pide Meta', () => {
  assert.equal(M.normalizarTelefono('+91 98765-43210'), '919876543210');
  assert.equal(M.normalizarTelefono('0091 98765 43210'), '919876543210');
  assert.equal(M.normalizarTelefono('12345'), null);
  assert.equal(M.normalizarCorreo(' Saleem@Example.com '), 'saleem@example.com');
  assert.equal(M.normalizarCorreo('sin arroba'), null);
});

test('el evento lleva el teléfono y el correo cifrados, nunca en claro', () => {
  const e = M.armarEvento({
    evento: 'Purchase',
    dealId: 3770947,
    persona: { telefonos: ['+91 98765-43210', '919876543210'], correos: ['Saleem@Example.com'] },
    at: Date.parse('2026-11-19T12:00:00Z'),
    valor: 400,
  });
  assert.deepEqual(e.user_data.ph, [sha('919876543210')], 'el mismo teléfono escrito de dos formas va una vez');
  assert.deepEqual(e.user_data.em, [sha('saleem@example.com')]);
  assert.equal(e.event_id, 'Purchase-3770947');
  assert.equal(e.action_source, 'chat');
  assert.equal(e.event_time, Date.parse('2026-11-19T12:00:00Z') / 1000);
  assert.deepEqual(e.custom_data, { value: 400, currency: 'USD' });
  const json = JSON.stringify(e);
  assert.doesNotMatch(json, /9876543210|saleem@/i);
  assert.deepEqual(M.armarEvento({ evento: 'SubmitApplication', dealId: 1, persona: { telefonos: [], correos: [] }, at: 0 }).custom_data, {});
});

test('sin el conjunto de datos y el token no se manda nada', async () => {
  delete process.env.META_CAPI_DATASET_ID;
  delete process.env.META_CAPI_TOKEN;
  aMeta.length = 0;
  assert.equal(M.capiConfigurada(), false);
  assert.deepEqual(await M.enviarEventoMeta({ evento: 'Purchase', dealId: 1, auth }), { ok: false, motivo: 'sin_configurar' });
  assert.equal(await M.registrarSolicitudInternacional({ dialogId: 'chat1', dealId: 1, mensajeCliente: 'I want to enrol', auth }), false);
  assert.equal(aMeta.length, 0);
});

test('se manda una sola vez por evento y negociación, con el token en el cuerpo', async () => {
  configurar();
  aMeta.length = 0;
  assert.deepEqual(await M.enviarEventoMeta({ evento: 'Purchase', dealId: 5001, valor: 400, auth }), { ok: true });
  assert.equal(aMeta.length, 1);
  assert.match(aMeta[0].url, /^https:\/\/graph\.facebook\.com\/v\d+\.\d+\/1234567890\/events$/);
  assert.doesNotMatch(aMeta[0].url, /token/, 'el token no va en la dirección');
  assert.equal(aMeta[0].body.access_token, 'token-de-prueba');
  assert.equal(aMeta[0].body.data[0].event_name, 'Purchase');
  assert.deepEqual(aMeta[0].body.data[0].user_data.ph, [sha('919876543210')]);
  assert.equal(aMeta[0].body.test_event_code, undefined);
  assert.deepEqual(await M.enviarEventoMeta({ evento: 'Purchase', dealId: 5001, valor: 400, auth }), { ok: false, motivo: 'ya_enviado' });
  assert.equal(aMeta.length, 1);
});

test('si Meta rechaza el evento, se puede reintentar', async () => {
  configurar();
  aMeta.length = 0;
  respuestaMeta = { status: 400, json: { error: { message: 'Invalid parameter' } } };
  const r = await M.enviarEventoMeta({ evento: 'Purchase', dealId: 5002, auth });
  assert.deepEqual(r, { ok: false, motivo: 'Invalid parameter' });
  respuestaMeta = { status: 200, json: { events_received: 1 } };
  assert.deepEqual(await M.enviarEventoMeta({ evento: 'Purchase', dealId: 5002, auth }), { ok: true });
  assert.equal(aMeta.length, 2);
});

test('con el código de prueba, los eventos van a «Probar eventos» y no bloquean el envío real', async () => {
  configurar();
  process.env.META_CAPI_TEST_CODE = 'TEST123';
  aMeta.length = 0;
  assert.deepEqual(await M.enviarEventoMeta({ evento: 'SubmitApplication', dealId: 5003, auth }), { ok: true });
  assert.equal(aMeta[0].body.test_event_code, 'TEST123');
  delete process.env.META_CAPI_TEST_CODE;
  assert.deepEqual(await M.enviarEventoMeta({ evento: 'SubmitApplication', dealId: 5003, auth }), { ok: true });
  assert.equal(aMeta.length, 2);
});

test('una negociación que no existe no se manda', async () => {
  configurar();
  aMeta.length = 0;
  assert.deepEqual(await M.enviarEventoMeta({ evento: 'Purchase', dealId: 404, auth }), { ok: false, motivo: 'sin_negociacion' });
  assert.equal(aMeta.length, 0);
});

test('el enlace de pago cuenta como solicitud solo si la persona pidió matricularse o pagar', async () => {
  configurar();
  aMeta.length = 0;
  pedidosAlModelo.length = 0;
  respuestaClasificador = 'NO';
  assert.equal(await M.registrarSolicitudInternacional({ dialogId: 'chat2', dealId: 6001, mensajeCliente: 'What is the fee?', auth }), false);
  assert.equal(aMeta.length, 0);
  assert.match(pedidosAlModelo.at(-1).messages[0].content, /PERSON \(last message\): What is the fee\?/);
  assert.match(pedidosAlModelo.at(-1).system, /price, fees, instalments/);
  respuestaClasificador = 'YES';
  assert.equal(await M.registrarSolicitudInternacional({ dialogId: 'chat2', dealId: 6001, mensajeCliente: 'Yes, send me the payment link', auth }), true);
  assert.equal(aMeta.at(-1)!.body.data[0].event_name, 'SubmitApplication');
  // Ya enviada: ni se vuelve a preguntar al clasificador.
  const antes = pedidosAlModelo.length;
  assert.equal(await M.registrarSolicitudInternacional({ dialogId: 'chat2', dealId: 6001, mensajeCliente: 'ok', auth }), false);
  assert.equal(pedidosAlModelo.length, antes);
  assert.equal(aMeta.length, 1);
});

test('«pagó 3770947» por el chat privado: anota el pago y le avisa a Meta', async () => {
  configurar();
  aMeta.length = 0;
  privados.length = 0;
  auditados.length = 0;
  filasPiloto = [{ dialog_id: 'chat3770947', ts: new Date(), type: 'turn', detail: { internacional: true }, primero: new Date(), crm_entity: 'deal#3770947' }];
  assert.equal(await A.atenderMensajeDelEquipo({ fromUserId: '4173', mensaje: 'Pagó 3770947', botId: 800185, auth }), 'pago_confirmado');
  assert.match(privados.at(-1)!, /anoté el pago de la negociación 3770947 \(Saleem\) por USD 400 y se lo avisé a Meta/);
  assert.equal(aMeta.length, 1);
  assert.equal(aMeta[0].body.data[0].event_name, 'Purchase');
  assert.deepEqual(aMeta[0].body.data[0].custom_data, { value: 400, currency: 'USD' });
  assert.ok(auditados.some((e) => e.type === 'pago_confirmado' && e.dialogId === 'chat3770947'));
  // Otro monto.
  filasPiloto.push({ dialog_id: 'chat3768645', ts: new Date(), type: 'turn', detail: { internacional: true }, primero: new Date(), crm_entity: 'deal#3768645' });
  await A.atenderMensajeDelEquipo({ fromUserId: '4173', mensaje: 'pagó 3768645 200', botId: 800185, auth });
  assert.deepEqual(aMeta.at(-1)!.body.data[0].custom_data, { value: 200, currency: 'USD' });
  // Repetido.
  await A.atenderMensajeDelEquipo({ fromUserId: '4173', mensaje: 'pagó 3770947', botId: 800185, auth });
  assert.match(privados.at(-1)!, /ya estaba anotado y avisado a Meta/);
  assert.equal(aMeta.length, 2);
});

test('«pagó» con un número que no es del piloto no marca a nadie', async () => {
  configurar();
  aMeta.length = 0;
  filasPiloto = [{ dialog_id: 'chatX', ts: new Date(), type: 'turn', detail: { internacional: true }, primero: new Date(), crm_entity: 'deal#1' }];
  await A.atenderMensajeDelEquipo({ fromUserId: '4173', mensaje: 'pagó 3770974', botId: 800185, auth });
  assert.match(privados.at(-1)!, /no aparece entre los chats del programa internacional/);
  assert.equal(aMeta.length, 0);
});

test('sin conectar Meta, el pago igual queda anotado', async () => {
  delete process.env.META_CAPI_DATASET_ID;
  delete process.env.META_CAPI_TOKEN;
  filasPiloto = [{ dialog_id: 'chat9', ts: new Date(), type: 'turn', detail: { internacional: true }, primero: new Date(), crm_entity: 'deal#9999' }];
  await A.atenderMensajeDelEquipo({ fromUserId: '4173', mensaje: 'pagó 9999', botId: 800185, auth });
  assert.match(privados.at(-1)!, /queda en el informe\. A Meta todavía no se le avisa/);
});

test('el informe cuenta los pagos confirmados', async () => {
  const { armarInforme } = await import('../src/routes/informeInternacional');
  const t = new Date('2026-11-19T10:00:00Z');
  const inf = armarInforme(
    [
      { dialog_id: 'c1', ts: t, type: 'turn', detail: { internacional: true, message: 'I want to join', reply: 'Great' }, primero: t, crm_entity: 'deal#11' },
      { dialog_id: 'c1', ts: t, type: 'pago_confirmado', detail: { valor: 400 }, primero: t, crm_entity: 'deal#11' },
    ] as any,
    Date.parse('2026-11-19T12:00:00Z'),
  );
  assert.equal(inf.totales.pagosConfirmados, 1);
  assert.deepEqual(inf.conSenales.map((x) => [x.negociacion, x.senales]), [[11, ['pago_confirmado']]]);
});

test('la ayuda explica cómo confirmar un pago', () => {
  assert.match(A.AYUDA_EQUIPO, /«pagó 3770947»/);
});

test.after(() => {
  globalThis.fetch = fetchOriginal;
});
