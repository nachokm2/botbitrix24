import { test } from 'node:test';
import assert from 'node:assert/strict';

// Mensajes en ráfaga (core/rafaga.ts). Caso real: "2.848.000" y "?" con 3 s de diferencia recibieron
// respuestas separadas, y al "?" el bot le contestó "parece que el mensaje llegó incompleto".
process.env.NODE_ENV = 'test';

const r = await import('../src/core/rafaga');

test('junta los mensajes del mismo remitente y marca los siguientes como respondidos', () => {
  r._limpiarRafagas();
  r.anotarEntrante('chat1', 'm1', 'cli', 'Si pago todo de contado cuánto me sale', 1000);
  r.anotarEntrante('chat1', 'm2', 'cli', '2.848.000', 2000);
  r.anotarEntrante('chat1', 'm3', 'cli', '?', 3000);
  assert.deepEqual(r.tomarRafaga('chat1', 'm1', 4000), ['Si pago todo de contado cuánto me sale', '2.848.000', '?']);
  assert.equal(r.fueAbsorbido('m1'), false, 'el propio no se descarta: es el que responde');
  assert.equal(r.fueAbsorbido('m2'), true);
  assert.equal(r.fueAbsorbido('m3'), true);
});

test('el mensaje de una asesora en medio de la ráfaga no se absorbe: va a su propio turno', () => {
  r._limpiarRafagas();
  r.anotarEntrante('chat2', 'a1', 'cli', 'hola', 1000);
  r.anotarEntrante('chat2', 'a2', 'asesora', 'Hola, le escribe Danna', 1500);
  r.anotarEntrante('chat2', 'a3', 'cli', 'quiero info del MBA', 2000);
  assert.deepEqual(r.tomarRafaga('chat2', 'a1', 3000), ['hola', 'quiero info del MBA']);
  assert.equal(r.fueAbsorbido('a2'), false);
  assert.deepEqual(r.tomarRafaga('chat2', 'a2', 3000), ['Hola, le escribe Danna']);
});

test('un mensaje que no se anotó (adjunto u otra réplica) no se lleva nada', () => {
  r._limpiarRafagas();
  r.anotarEntrante('chat3', 'b1', 'cli', 'hola', 1000);
  assert.deepEqual(r.tomarRafaga('chat3', 'otro', 2000), []);
});

test('Bitrix reenvía eventos: el mismo id no se anota dos veces', () => {
  r._limpiarRafagas();
  r.anotarEntrante('chat4', 'c1', 'cli', 'hola', 1000);
  r.anotarEntrante('chat4', 'c1', 'cli', 'hola', 1100);
  assert.deepEqual(r.tomarRafaga('chat4', 'c1', 2000), ['hola']);
});

test('espera a que el chat quede quieto, pero con tope', async () => {
  r._limpiarRafagas();
  r.anotarEntrante('chat5', 'd1', 'cli', 'hola');
  let t = Date.now();
  await r.esperarFinDeRafaga('chat5', 200, 2000);
  assert.ok(Date.now() - t >= 150, 'esperó la ventana');
  r.anotarEntrante('chat5', 'd2', 'cli', 'sigo');
  t = Date.now();
  await r.esperarFinDeRafaga('chat5', 5000, 100);
  assert.ok(Date.now() - t < 1000, 'el tope corta la espera');
});
