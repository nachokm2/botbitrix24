import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Modo copiloto: el bot redacta, el asesor envía. Ataca por el otro lado el problema del piloto —de
// 38 derivaciones, 4 trabajadas—: en vez de pedirle trabajo al asesor, entregárselo medio hecho.
//
// Lo crítico acá es que el cliente NO reciba nada automático: si el bot escribiera igual, la
// persona recibiría dos respuestas y el modo perdería todo sentido.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

let deal: any = { CATEGORY_ID: '73', ASSIGNED_BY_ID: '1313' };
let fallaCrm = false;
let fallaNotificacion = false;
const notificaciones: any[] = [];
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callCrm: async () => {
      if (fallaCrm) throw new Error('expired token');
      return deal;
    },
    callBitrix: async (method: string, params: any) => {
      if (method === 'im.notify.personal.add') {
        if (fallaNotificacion) throw new Error('no se pudo notificar');
        notificaciones.push(params);
      }
      return {};
    },
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: {} }),
    callWebhook: async () => ({}),
  },
});

const auditCalls: any[] = [];
mock.module('../src/obs/audit.ts', { namedExports: { audit: async (e: any) => { auditCalls.push(e); } } });

const { aplicaCopiloto, entregarBorrador } = await import('../src/ai/copiloto');
const { config } = await import('../src/config');

const auth = { domain: 'test.bitrix24.com', access_token: 'tok' } as any;

function reset() {
  notificaciones.length = 0;
  auditCalls.length = 0;
  fallaCrm = false;
  fallaNotificacion = false;
  deal = { CATEGORY_ID: '73', ASSIGNED_BY_ID: '1313' };
  config.copilotoActivo = false;
  config.copilotoCategorias = [];
  config.copilotoDestino = 0;
}

test('apagado por defecto: el bot responde como siempre', async () => {
  reset();
  assert.equal(await aplicaCopiloto({ deal: 1 }, auth), false);
});

test('encendido sin filtro de embudo aplica a todo', async () => {
  reset();
  config.copilotoActivo = true;
  assert.equal(await aplicaCopiloto({ deal: 1 }, auth), true);
  assert.equal(await aplicaCopiloto({}, auth), true);
});

test('con filtro de embudo solo aplica a los configurados', async () => {
  reset();
  config.copilotoActivo = true;
  config.copilotoCategorias = [73, 135];
  deal = { CATEGORY_ID: '73' };
  assert.equal(await aplicaCopiloto({ deal: 1 }, auth), true);
  deal = { CATEGORY_ID: '1' };
  assert.equal(await aplicaCopiloto({ deal: 1 }, auth), false);
});

test('con filtro de embudo, una conversación sin negociación no entra', async () => {
  reset();
  config.copilotoActivo = true;
  config.copilotoCategorias = [73];
  assert.equal(await aplicaCopiloto({}, auth), false);
});

test('si no se puede leer el embudo, se responde normal', async () => {
  // Ante la duda, el comportamiento de siempre: dejar al cliente sin respuesta sería peor.
  reset();
  config.copilotoActivo = true;
  config.copilotoCategorias = [73];
  fallaCrm = true;
  assert.equal(await aplicaCopiloto({ deal: 1 }, auth), false);
});

test('el borrador va al responsable de la negociación', async () => {
  reset();
  const r = await entregarBorrador({
    respuesta: 'El arancel es de USD 2.300 al año.',
    mensajeCliente: '¿cuánto cuesta?',
    dialogId: 'chat1',
    crmEntities: { deal: 500 },
    auth,
  });
  assert.equal(r.entregado, true);
  assert.equal(r.destino, 1313);
  assert.match(notificaciones[0].MESSAGE, /cuánto cuesta/);
  assert.match(notificaciones[0].MESSAGE, /USD 2.300/);
  assert.match(notificaciones[0].MESSAGE, /no le escribió nada al cliente/, 'el asesor debe saber que debe enviarla él');
  assert.match(notificaciones[0].MESSAGE, /deal\/details\/500/);
  assert.ok(auditCalls.some((a) => a.type === 'copiloto_borrador'));
});

test('un destinatario fijo tiene prioridad sobre el responsable', async () => {
  reset();
  config.copilotoDestino = 999;
  const r = await entregarBorrador({ respuesta: 'x', mensajeCliente: 'y', dialogId: 'c', crmEntities: { deal: 1 }, auth });
  assert.equal(r.destino, 999);
});

test('sin a quién entregarlo lo informa en vez de perderlo', async () => {
  reset();
  deal = { CATEGORY_ID: '73', ASSIGNED_BY_ID: '0' };
  const r = await entregarBorrador({ respuesta: 'x', mensajeCliente: 'y', dialogId: 'c', crmEntities: { deal: 1 }, auth });
  assert.deepEqual(r, { entregado: false, motivo: 'sin_destinatario' });
});

test('si la notificación falla lo dice: quien llama decide qué hacer', async () => {
  reset();
  fallaNotificacion = true;
  const r = await entregarBorrador({ respuesta: 'x', mensajeCliente: 'y', dialogId: 'c', crmEntities: { deal: 1 }, auth });
  assert.equal(r.entregado, false);
  assert.equal(r.motivo, 'fallo_envio');
});

test('un borrador muy largo se recorta en vez de reventar la notificación', async () => {
  reset();
  const r = await entregarBorrador({
    respuesta: 'x'.repeat(4000),
    mensajeCliente: 'y'.repeat(2000),
    dialogId: 'c',
    crmEntities: { deal: 1 },
    auth,
  });
  assert.equal(r.entregado, true);
  assert.ok(notificaciones[0].MESSAGE.length < 2500);
});
