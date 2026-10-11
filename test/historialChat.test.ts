import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Leer lo que ya se habló en un chat ANTES de que el bot entrara. Hasta ahora, sumar el bot a una
// conversación en curso lo hacía arrancar en blanco: la memoria entre sesiones son las notas que el
// propio bot dejó en el CRM, así que de un chat atendido a mano por un asesor no sabía nada.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

let respuesta: any = { messages: [] };
let fallar = false;
const llamadas: any[] = [];
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: async (method: string, params: any) => {
      llamadas.push({ method, params });
      if (fallar) throw new Error('ERROR_METHOD_NOT_FOUND');
      return respuesta;
    },
    callCrm: async () => ({}),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: {} }),
    callWebhook: async () => ({}),
  },
});

const { leerHistorialPrevio } = await import('../src/crm/historialChat');
const auth = { domain: 'test.bitrix24.com', access_token: 'tok' } as any;

/** Bitrix devuelve los mensajes del más NUEVO al más viejo. */
const msg = (id: number, author: string, text: string) => ({ id, author_id: author, text });

test('arma la transcripción en orden de conversación, etiquetando quién habló', async () => {
  fallar = false;
  respuesta = { messages: [msg(3, '77', 'Te paso el valor'), msg(2, '55', 'Sí, el de psicología'), msg(1, '77', 'Hola, ¿qué programa busca?')] };
  const h = await leerHistorialPrevio('chat9', '55', auth);

  assert.ok(h);
  assert.equal(
    h.transcripcion,
    'Equipo: Hola, ¿qué programa busca?\nCliente: Sí, el de psicología\nEquipo: Te paso el valor',
  );
  assert.match(h.instruccion, /un colega participó/);
  assert.match(h.instruccion, /NO contradigas/);
  assert.equal(llamadas[0].method, 'im.dialog.messages.get');
  assert.equal(llamadas[0].params.DIALOG_ID, 'chat9');
});

test('sin participación del equipo, la instrucción no habla de colegas', async () => {
  fallar = false;
  respuesta = { messages: [msg(2, '55', 'Hola?'), msg(1, '55', 'Buenas tardes')] };
  const h = await leerHistorialPrevio('chat9', '55', auth);
  assert.ok(h);
  assert.doesNotMatch(h.instruccion, /colega/);
  assert.equal(h.transcripcion, 'Cliente: Buenas tardes\nCliente: Hola?');
});

test('no duplica el mensaje que acaba de llegar: ese ya va como turno del usuario', async () => {
  fallar = false;
  respuesta = { messages: [msg(2, '55', 'Mensaje nuevo'), msg(1, '55', 'Mensaje viejo')] };
  const h = await leerHistorialPrevio('chat9', '55', auth, 2);
  assert.ok(h);
  assert.equal(h.transcripcion, 'Cliente: Mensaje viejo');
});

test('limpia el BBCode de Bitrix', async () => {
  fallar = false;
  respuesta = { messages: [msg(1, '55', '[B]Hola[/B][br]quiero info')] };
  const h = await leerHistorialPrevio('chat9', '55', auth);
  assert.equal(h!.transcripcion, 'Cliente: Hola quiero info');
});

test('un mensaje muy largo se recorta y no infla el prompt', async () => {
  fallar = false;
  respuesta = { messages: [msg(1, '55', 'x'.repeat(900))] };
  const h = await leerHistorialPrevio('chat9', '55', auth);
  assert.ok(h!.transcripcion.length < 400);
  assert.ok(h!.transcripcion.endsWith('…'));
});

test('si el método no existe en el portal, no rompe el turno', async () => {
  fallar = true;
  assert.equal(await leerHistorialPrevio('chat9', '55', auth), null);
});

test('un chat sin mensajes previos no aporta bloque', async () => {
  fallar = false;
  respuesta = { messages: [] };
  assert.equal(await leerHistorialPrevio('chat9', '55', auth), null);
});

test('mensajes de sistema sin texto se descartan', async () => {
  fallar = false;
  respuesta = { messages: [{ id: 2, author_id: '0', text: '' }, msg(1, '55', 'Hola')] };
  const h = await leerHistorialPrevio('chat9', '55', auth);
  assert.equal(h!.transcripcion, 'Cliente: Hola');
});
