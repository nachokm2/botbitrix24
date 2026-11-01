import { test } from 'node:test';
import assert from 'node:assert/strict';

// Cuándo el bot retoma un chat que tomó una persona (ai/retomarChat.ts). Caso real del 31-10-2026: una
// clienta mandó sus datos y "la idea es iniciar en noviembre" a una asesora que volvía el lunes.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

const { leerEstado, motivoParaNoRetomar } = await import('../src/ai/retomarChat');

const BOT = 800185;
const participantes = [
  { id: BOT, bot: true },
  { id: 62741 }, // la asesora
  { id: 820437, connector: true, extranet: true }, // la clienta
];
const ahora = Date.parse('2026-10-31T23:00:00Z');
const hace = (horas: number) => new Date(ahora - horas * 3600_000).toISOString();
const msj = (id: number, autor: number, horas: number, text: string) => ({ id, author_id: autor, date: hace(horas), text });

test('lee lo que el cliente dejó sin responder, después de la última respuesta del bot o del equipo', () => {
  const e = leerEstado(
    participantes,
    [
      msj(1, 820437, 6, '¿Le interesa entrar en noviembre?'),
      msj(2, BOT, 5.9, 'Si es así, continuamos con los datos que faltan.'),
      msj(3, 0, 5.9, 'El bot reenvió la conversación a un agente'),
      msj(4, 820437, 5.8, '+57 3206352472'),
      msj(5, 820437, 5.7, 'La idea es iniciar en noviembre'),
    ],
    BOT,
  );
  assert.deepEqual(e.equipo, ['62741']);
  assert.equal(e.clienteId, '820437');
  assert.deepEqual(e.pendientes, ['+57 3206352472', 'La idea es iniciar en noviembre']);
  assert.equal(e.ultimoPendienteId, '5');
  assert.equal(e.ultimaDelEquipo, 0, 'el bot no cuenta como actividad del equipo');
});

test('retoma si la clienta espera y nadie del equipo escribe hace 4 h', () => {
  const e = leerEstado(participantes, [msj(1, BOT, 6, 'Datos, por favor'), msj(2, 820437, 5.8, 'Iniciar en noviembre')], BOT);
  assert.equal(motivoParaNoRetomar(e, ahora - 6 * 3600_000, 4, ahora), null);
});

test('no retoma una conversación viva: la asesora escribió hace poco', () => {
  const e = leerEstado(participantes, [msj(1, 62741, 1, 'Hola, ¿cómo está?'), msj(2, 820437, 0.5, 'Bien, gracias')], BOT);
  assert.equal(motivoParaNoRetomar(e, ahora - 6 * 3600_000, 4, ahora), 'el_equipo_estuvo_activo_hace_poco');
});

test('no retoma si el traspaso es reciente aunque la asesora no haya escrito', () => {
  const e = leerEstado(participantes, [msj(1, 820437, 1, 'Hola')], BOT);
  assert.equal(motivoParaNoRetomar(e, ahora - 2 * 3600_000, 4, ahora), 'el_equipo_estuvo_activo_hace_poco');
});

test('no retoma si el cliente no espera respuesta, si ya no hay nadie del equipo, o fuera de la ventana de 24 h', () => {
  const respondido = leerEstado(participantes, [msj(1, 820437, 8, 'Gracias'), msj(2, 62741, 7, 'A usted')], BOT);
  assert.equal(motivoParaNoRetomar(respondido, 0, 4, ahora), 'el_cliente_no_espera_respuesta');

  const sinEquipo = leerEstado([{ id: BOT, bot: true }, { id: 820437, connector: true }], [msj(1, 820437, 8, 'Hola')], BOT);
  assert.equal(motivoParaNoRetomar(sinEquipo, 0, 4, ahora), 'nadie_del_equipo_en_el_chat');

  const viejo = leerEstado(participantes, [msj(1, 820437, 30, 'Hola')], BOT);
  assert.equal(motivoParaNoRetomar(viejo, 0, 4, ahora), 'fuera_de_la_ventana_de_24h');
});
