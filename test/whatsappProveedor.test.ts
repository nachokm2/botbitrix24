import { test } from 'node:test';
import assert from 'node:assert/strict';

// Envío por un proveedor genérico (WA_PROVIDER=custom). Existe porque el WhatsApp de Carver no sale
// por Meta directo sino por ChatApp, que direcciona con el teléfono DENTRO de la URL:
//   /v1/licenses/<licencia>/messengers/caWhatsApp/chats/<teléfono>/messages
// Antes las variables solo se sustituían en el cuerpo, así que ese proveedor no era configurable.
process.env.NODE_ENV = 'test';

const { enviarPlantillaWhatsApp } = await import('../src/whatsapp/template');

type Llamada = { url: string; body: string; headers: any };
let ultima: Llamada | null = null;
let respuesta = { ok: true, status: 200, texto: '{"ok":true}' };

const fetchOriginal = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any) => {
  ultima = { url: String(url), body: String(init?.body ?? ''), headers: init?.headers };
  return {
    ok: respuesta.ok,
    status: respuesta.status,
    text: async () => respuesta.texto,
    json: async () => JSON.parse(respuesta.texto),
  };
}) as any;

function configurar() {
  process.env.WA_PROVIDER = 'custom';
  process.env.WA_API_URL = 'https://api.chatapp.online/v1/licenses/39039/messengers/caWhatsApp/chats/{{toSinMas}}/messages';
  process.env.WA_API_HEADERS = '{"Content-Type":"application/json","Authorization":"clave-de-prueba"}';
  process.env.WA_API_BODY = '{"type":"template","template":{"name":"{{template}}","language":"{{lang}}","params":["{{param0}}","{{param1}}"]}}';
  ultima = null;
  respuesta = { ok: true, status: 200, texto: '{"ok":true}' };
}

const enviar = () =>
  enviarPlantillaWhatsApp({
    phoneE164: '+56912345678',
    template: 'primer_contacto_v1',
    lang: 'es',
    params: ['Camila', 'Maestría en Psicología'],
  });

test('pone el destinatario en la URL, que es donde ChatApp lo espera', async () => {
  configurar();
  const r = await enviar();
  assert.equal(r.ok, true);
  assert.equal(
    ultima!.url,
    'https://api.chatapp.online/v1/licenses/39039/messengers/caWhatsApp/chats/56912345678/messages',
    'sin el "+", que varios proveedores rechazan',
  );
});

test('sustituye plantilla, idioma y parámetros en el cuerpo', async () => {
  configurar();
  await enviar();
  const body = JSON.parse(ultima!.body);
  assert.equal(body.template.name, 'primer_contacto_v1');
  assert.equal(body.template.language, 'es');
  assert.deepEqual(body.template.params, ['Camila', 'Maestría en Psicología']);
});

test('manda las cabeceras configuradas', async () => {
  configurar();
  await enviar();
  assert.equal(ultima!.headers.Authorization, 'clave-de-prueba');
});

test('{{to}} conserva el "+" para proveedores que sí lo quieren', async () => {
  configurar();
  process.env.WA_API_URL = 'https://ejemplo.test/send/{{to}}';
  await enviar();
  assert.equal(ultima!.url, 'https://ejemplo.test/send/+56912345678');
});

test('un error del proveedor se devuelve, no se traga', async () => {
  configurar();
  respuesta = { ok: false, status: 422, texto: 'plantilla no aprobada' };
  const r = await enviar();
  assert.equal(r.ok, false);
  assert.match(String(r.error), /422/);
  assert.match(String(r.error), /plantilla no aprobada/);
});

test('sin WA_API_URL no intenta enviar', async () => {
  configurar();
  process.env.WA_API_URL = '';
  ultima = null;
  const r = await enviar();
  assert.equal(r.ok, false);
  assert.equal(ultima, null, 'no debe salir ninguna petición');
});

test.after(() => {
  globalThis.fetch = fetchOriginal;
  process.env.WA_PROVIDER = '';
});
