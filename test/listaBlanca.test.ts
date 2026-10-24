import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Modo prueba: el bot solo le responde a los números de la lista y calla con todos los demás.
//
// Sirve para probar en vivo sin arriesgar conversaciones reales. Apagar el bot entero no deja
// probar nada; dejarlo abierto significa que cualquier lead que escriba se lleva una versión que
// todavía se está ajustando.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

// Identificador real de un chat de Open Lines: conector | línea | teléfono de quien escribe | user.
const CHATS: Record<string, string> = {
  chat9001: 'ank_chats_app24_ca_whats_app|31|56923883848|805047', // el número de la lista
  chat9002: 'ank_chats_app24_ca_whats_app|31|573143961270|805047', // un cliente real
  chat9003: 'formato|raro', // sin teléfono reconocible
};

let fallaBitrix = false;
const consultas: string[] = [];
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: async (method: string, params: any) => {
      consultas.push(method);
      if (fallaBitrix) throw new Error('Bitrix no responde');
      if (method === 'im.dialog.get') return { entity_id: CHATS[String(params.DIALOG_ID)] ?? '' };
      return {};
    },
    callCrm: async () => ({}),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: [] }),
    callWebhook: async () => ({}),
  },
});

const { puedeResponder, telefonoDelChat, lineaDelChat, listaBlancaActiva, _limpiarCacheListaBlanca } = await import(
  '../src/core/listaBlanca'
);
const { config } = await import('../src/config');
const auth = { domain: 'test.bitrix24.com', access_token: 'tok' } as any;

function conLista(numeros: string[]) {
  config.soloEstosNumeros = numeros;
  _limpiarCacheListaBlanca();
  consultas.length = 0;
  fallaBitrix = false;
}

test('sin lista configurada, el bot atiende a todos (comportamiento normal)', async () => {
  conLista([]);
  assert.equal(listaBlancaActiva(), false);
  assert.equal(await puedeResponder('9002', auth), true, 'un cliente cualquiera');
  assert.equal(consultas.length, 0, 'ni siquiera consulta a Bitrix');
});

test('con lista, responde al número de la lista', async () => {
  conLista(['+56923883848']);
  assert.equal(listaBlancaActiva(), true);
  assert.equal(await puedeResponder('9001', auth), true);
});

test('EL PUNTO: NO le responde a nadie más', async () => {
  conLista(['+56923883848']);
  assert.equal(await puedeResponder('9002', auth), false, 'un cliente real queda sin respuesta del bot');
});

test('el formato del número no importa: se comparan solo los dígitos', async () => {
  // El chat trae "56923883848" y la configuración puede venir con +, espacios o guiones.
  for (const escrito of ['+56923883848', '56923883848', '+56 9 2388 3848', '+56-9-2388-3848']) {
    conLista([escrito]);
    assert.equal(await puedeResponder('9001', auth), true, escrito);
  }
});

test('admite varios números en la lista', async () => {
  conLista(['+56911111111', '+56923883848']);
  assert.equal(await puedeResponder('9001', auth), true);
  assert.equal(await puedeResponder('9002', auth), false);
});

test('si no se puede identificar el número, NO responde', async () => {
  // Al revés que casi todo el resto del proyecto, acá se falla CERRADO: en modo prueba un silencio
  // de más es gratis, pero una respuesta de más va a un cliente real que no debía recibirla.
  conLista(['+56923883848']);
  assert.equal(await puedeResponder('9003', auth), false, 'identificador sin teléfono');
  assert.equal(await puedeResponder(undefined, auth), false, 'sin chat');

  fallaBitrix = true;
  _limpiarCacheListaBlanca();
  assert.equal(await puedeResponder('9001', auth), false, 'Bitrix caído: tampoco responde');
});

test('el teléfono se lee del chat, no del CRM', async () => {
  // En modo prueba importa de qué WhatsApp llegó el mensaje, no a qué contacto lo asoció Bitrix,
  // que puede ser otro o ninguno.
  conLista(['+56923883848']);
  assert.equal(await telefonoDelChat('9001', auth), '56923883848');
  assert.equal(await telefonoDelChat('9002', auth), '573143961270');
});

test('no consulta a Bitrix una vez por mensaje: cachea el número del chat', async () => {
  conLista(['+56923883848']);
  await puedeResponder('9001', auth);
  const tras1 = consultas.length;
  await puedeResponder('9001', auth);
  await puedeResponder('9001', auth);
  assert.equal(consultas.length, tras1, 'las siguientes salen de la caché');
});

// lineaDelChat: el ID de línea sale del mismo identificador (conector|LÍNEA|...). Lo usa la compuerta
// de líneas permitidas para dejar el bot solo en un canal (p. ej. Carver en la 93).
test('lineaDelChat devuelve el ID de línea del chat (WhatsApp y Live Chat)', async () => {
  conLista([]);
  CHATS['chat9004'] = 'livechat|93|0|805047';
  _limpiarCacheListaBlanca();
  assert.equal(await lineaDelChat('9001', auth), '31', 'WhatsApp línea 31');
  assert.equal(await lineaDelChat('9004', auth), '93', 'Live Chat línea 93');
  assert.equal(await lineaDelChat('9002', auth), '31');
});

test('lineaDelChat: si Bitrix falla, devuelve null (la compuerta falla cerrada)', async () => {
  conLista([]);
  fallaBitrix = true;
  _limpiarCacheListaBlanca();
  assert.equal(await lineaDelChat('9001', auth), null);
});
