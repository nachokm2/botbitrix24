import { test } from 'node:test';
import assert from 'node:assert/strict';

// 18-11-2026: datos del piloto internacional para el informe diario que actualiza un agente en la nube
// (routes/informeInternacional.ts). Protegidos con token y con teléfonos y correos ocultos.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.MARCA = 'carver';
process.env.INTERNACIONAL_PREFIJOS = '+91';

const { armarInforme, ocultarDatos, informeInternacional } = await import('../src/routes/informeInternacional');

const AHORA = Date.parse('2026-11-18T12:00:00Z');
const hace = (h: number) => new Date(AHORA - h * 3600_000);
const ANUNCIO = 'Hello! Can I get more info on this?\n\nhttps://fb.me/x\n\nPut AI to Work';
const turno = (chat: string, h: number, primeroH: number, message: string, deal = 1) => ({
  dialog_id: chat,
  ts: hace(h),
  type: 'turn',
  detail: { internacional: true, message, reply: 'Hi! It is a 16-week course.' },
  primero: hace(primeroH),
  crm_entity: `deal#${deal}`,
});

test('oculta teléfonos, correos y enlaces', () => {
  assert.equal(ocultarDatos('Mail me at ana.k@gmail.com or +91 98765 43210, see https://x.com/a'), 'Mail me at [correo] or [teléfono], see [link]');
});

test('cuenta chats, contenido, señales y conversaciones de las últimas 24 h', () => {
  const filas = [
    turno('chat1', 60, 60, ANUNCIO, 11),
    turno('chat2', 30, 30, ANUNCIO, 22),
    turno('chat2', 29, 30, 'No code', 22),
    turno('chat2', 28, 30, 'How much is it?', 22),
    turno('chat2', 27, 30, 'Lets do it, my email is ana@x.com', 22),
    turno('chat3', 5, 5, ANUNCIO, 33),
    turno('chat3', 4, 5, '[voice message] Is it online?', 33),
    { dialog_id: 'chat2', ts: hace(27), type: 'tool_call', detail: { name: 'registrar_interes_crm', input: { email: 'ana@x.com' } }, primero: hace(30), crm_entity: 'deal#22' },
    { dialog_id: 'chat2', ts: hace(27), type: 'interes_internacional', detail: { motivo: 'enlace_pago' }, primero: hace(30), crm_entity: 'deal#22' },
    { dialog_id: 'chat1', ts: hace(50), type: 'seguimiento', detail: { internacional: true }, primero: hace(60), crm_entity: null },
    { dialog_id: 'chat1', ts: hace(40), type: 'seguimiento_omitido', detail: { motivo: 'no_es_prospecto' }, primero: hace(60), crm_entity: null },
    { dialog_id: 'chat1', ts: hace(2), type: 'bot_en_silencio', detail: { motivo: 'sin_contenido' }, primero: hace(60), crm_entity: null },
  ];
  const r = armarInforme(filas, AHORA, 1);
  assert.equal(r.totales.chats, 3);
  assert.equal(r.totales.soloAnuncio, 1);
  assert.equal(r.totales.conContenido, 2);
  assert.equal(r.totales.conversaron, 1);
  assert.equal(r.totales.correos, 1);
  assert.equal(r.totales.enlacesDePago, 1);
  assert.equal(r.totales.consultasAbiertas, 1);
  assert.equal(r.totales.recordatoriosEnviados, 1);
  assert.equal(r.totales.recordatoriosOmitidosNoProspecto, 1);
  assert.equal(r.totales.silenciosSinContenido, 1);
  assert.equal(r.totales.audios, 1);
  assert.deepEqual(r.conSenales, [{ chat: 'chat2', negociacion: 22, senales: ['correo', 'enlace_pago'] }]);
  assert.equal(r.conversaciones24h.length, 1, 'solo chat3 tuvo actividad en las últimas 24 h');
  assert.equal(r.conversaciones24h[0].negociacion, 33);
  assert.equal(r.conversaciones24h[0].nuevo, true);
  assert.match(JSON.stringify(r.conversaciones24h), /Is it online\?/);
  assert.doesNotMatch(JSON.stringify(r), /ana@x\.com/, 'en las conversaciones no sale el correo');
  assert.equal(r.chatsPorDia.reduce((s, d) => s + d.chats, 0), 3);
});

test('sin token, o con uno equivocado, responde 404', async () => {
  process.env.INFORME_INTERNACIONAL_TOKEN = 'a'.repeat(32);
  const res: any = { statusCode: 200, cuerpo: null, status(c: number) { this.statusCode = c; return this; }, json(b: any) { this.cuerpo = b; return this; }, setHeader() {} };
  await informeInternacional({ query: {}, header: () => undefined } as any, res);
  assert.equal(res.statusCode, 404);
  await informeInternacional({ query: { token: 'b'.repeat(32) }, header: () => undefined } as any, res);
  assert.equal(res.statusCode, 404);
  delete process.env.INFORME_INTERNACIONAL_TOKEN;
  await informeInternacional({ query: { token: 'a'.repeat(32) }, header: () => undefined } as any, res);
  assert.equal(res.statusCode, 404, 'sin la variable, la ruta no existe');
});
