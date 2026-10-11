import { test } from 'node:test';
import assert from 'node:assert/strict';

// Proveedor ChatApp: por donde sale el WhatsApp de Carver. Lo que más importa probar es el cacheo
// del token — la API permite 100 emisiones diarias por email+appId, así que pedir uno por mensaje
// agotaría la cuota a los 100 envíos y dejaría al bot sin poder escribir.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.CHATAPP_EMAIL = 'cuenta@ejemplo.cl';
process.env.CHATAPP_PASSWORD = 'secreto';
process.env.CHATAPP_APP_ID = 'app_21296_1';
process.env.CHATAPP_LICENSE_ID = '50126';

type Llamada = { url: string; method: string; body: any; auth?: string };
const llamadas: Llamada[] = [];
let tokensEmitidos = 0;
let siguienteEnvio: { status: number; body: any } = { status: 200, body: { success: true, data: { id: 'msg-1' } } };

const fetchOriginal = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any) => {
  const u = String(url);
  const headers = (init?.headers ?? {}) as Record<string, string>;
  llamadas.push({ url: u, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null, auth: headers.Authorization });

  if (u.endsWith('/v1/tokens')) {
    tokensEmitidos++;
    return respuesta(200, { success: true, data: { accessToken: `tok-${tokensEmitidos}`, refreshToken: 'ref' } });
  }
  if (u.includes('/templates')) {
    return respuesta(200, {
      success: true,
      data: { items: [{ id: 'uuid-1', elementName: 'primer_contacto', languageCode: 'es', status: 'APPROVED', templateType: 'TEXT', data: 'Hola {{1}}' }] },
    });
  }
  return respuesta(siguienteEnvio.status, siguienteEnvio.body);
}) as any;

function respuesta(status: number, body: any) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body };
}

const { enviarPlantilla, listarPlantillas } = await import('../src/whatsapp/chatapp');

function reset() {
  llamadas.length = 0;
  tokensEmitidos = 0;
  siguienteEnvio = { status: 200, body: { success: true, data: { id: 'msg-1' } } };
}

const enviar = () =>
  enviarPlantilla({ phoneE164: '+56912345678', templateId: 'uuid-1', params: ['Camila', 'Maestría en Psicología'] });

test('arma la ruta de envío con la licencia, el canal y el teléfono sin "+"', async () => {
  reset();
  const r = await enviar();
  assert.equal(r.ok, true);
  const envio = llamadas.find((l) => l.url.includes('/messages/template'))!;
  assert.equal(envio.url, 'https://api.chatapp.online/v1/licenses/50126/messengers/caWhatsApp/chats/56912345678/messages/template');
  assert.equal(envio.method, 'POST');
});

test('identifica la plantilla por id y manda los parámetros como lista', async () => {
  reset();
  await enviar();
  const envio = llamadas.find((l) => l.url.includes('/messages/template'))!;
  assert.deepEqual(envio.body, { template: { id: 'uuid-1', params: ['Camila', 'Maestría en Psicología'] } });
});

test('reutiliza el token entre envíos: la cuota es de 100 al día', async () => {
  reset();
  // Se mide el DELTA, no el total: el token cacheado puede venir de una prueba anterior, que es
  // justamente el comportamiento deseado.
  const antes = tokensEmitidos;
  await enviar();
  await enviar();
  await enviar();
  assert.ok(tokensEmitidos - antes <= 1, `pidió ${tokensEmitidos - antes} tokens para tres envíos`);
  const envios = llamadas.filter((l) => l.url.includes('/messages/template'));
  assert.equal(envios.length, 3);
  assert.equal(new Set(envios.map((e) => e.auth)).size, 1, 'los tres salen con el mismo token');
});

test('ante un 401 renueva el token una vez y reintenta', async () => {
  reset();
  let primera = true;
  siguienteEnvio = { status: 200, body: { success: true, data: { id: 'ok' } } };
  const fetchGuardado = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    if (u.includes('/messages/template') && primera) {
      primera = false;
      llamadas.push({ url: u, method: 'POST', body: null });
      return respuesta(401, { success: false });
    }
    return (fetchGuardado as any)(url, init);
  }) as any;

  const r = await enviar();
  globalThis.fetch = fetchGuardado;
  assert.equal(r.ok, true, 'el reintento debe salir bien');
  assert.equal(tokensEmitidos, 1, 'se pidió un token nuevo tras el 401');
});

test('un error del proveedor se devuelve con su detalle', async () => {
  reset();
  siguienteEnvio = { status: 422, body: { success: false, message: 'template not approved' } };
  const r = await enviar();
  assert.equal(r.ok, false);
  assert.match(String((r as any).error), /422|template not approved/);
});

test('success:false con HTTP 200 también es error', async () => {
  reset();
  siguienteEnvio = { status: 200, body: { success: false, message: 'invalid chat' } };
  const r = await enviar();
  assert.equal(r.ok, false);
});

test('sin licencia no intenta enviar', async () => {
  reset();
  const r = await enviarPlantilla({ phoneE164: '+56912345678', templateId: 'uuid-1', params: [], licenseId: 0 });
  assert.equal(r.ok, false);
  assert.match(String((r as any).error), /LICENSE/i);
  assert.equal(llamadas.length, 0);
});

test('lista las plantillas de la licencia', async () => {
  reset();
  const items = await listarPlantillas(50126);
  assert.equal(items.length, 1);
  assert.equal(items[0].elementName, 'primer_contacto');
  assert.equal(items[0].status, 'APPROVED');
  const consulta = llamadas.find((l) => l.url.includes('/templates'))!;
  assert.equal(consulta.url, 'https://api.chatapp.online/v1/licenses/50126/messengers/caWhatsApp/templates');
});

test.after(() => {
  globalThis.fetch = fetchOriginal;
});
