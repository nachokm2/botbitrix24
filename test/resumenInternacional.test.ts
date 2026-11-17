import { test } from 'node:test';
import assert from 'node:assert/strict';

// 17-11-2026: resumen diario del modo internacional por el chat privado del bot, propuesta semanal para
// la ficha y prueba A/B del primer mensaje (ai/resumenInternacional.ts, core/pruebaPrimerMensaje.ts).
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.MARCA = 'carver';
process.env.INTERNACIONAL_PREFIJOS = '+91';
process.env.INTERNACIONAL_AVISAR_A = '4173';

const { calcularResumen, textoResumen, textoPropuestaFicha } = await import('../src/ai/resumenInternacional');
const { varianteDePrimerMensaje, BLOQUE_PRIMER_MENSAJE_B } = await import('../src/core/pruebaPrimerMensaje');
const { promptInternacional } = await import('../src/core/internacional');

const AHORA = Date.parse('2026-11-18T12:00:00Z');
const hace = (h: number) => new Date(AHORA - h * 3600_000);
const ANUNCIO = 'Hello! Can I get more info on this?\n\nhttps://fb.me/x\n\nPut AI to Work';
const turno = (dialog: string, h: number, primeroH: number, message: string, variante?: 'A' | 'B') => ({
  dialog_id: dialog,
  ts: hace(h),
  type: 'turn',
  detail: { internacional: true, message, reply: 'ok', ...(variante ? { variante } : {}) },
  primero: hace(primeroH),
});

test('el resumen cuenta nuevos, interesados, consultas, recordatorios y la prueba del primer mensaje', () => {
  const filas = [
    // Viejo (de hace 3 días), con actividad hoy.
    turno('chat1', 72, 72, ANUNCIO, 'A'),
    turno('chat1', 5, 72, 'Is it online?'),
    // Nuevo, solo el anuncio (variante B), hace 10 h.
    turno('chat2', 10, 10, ANUNCIO, 'B'),
    // Nuevo con contenido (variante A), hace 6 h; volvió a escribir.
    turno('chat4', 6, 6, ANUNCIO, 'A'),
    turno('chat4', 5, 6, 'No code, how much is it?'),
    // Nuevo hace 1 h: todavía no cuenta para la prueba (menos de 3 h).
    turno('chat3', 1, 1, ANUNCIO, 'B'),
    { dialog_id: 'chat4', ts: hace(4), type: 'tool_call', detail: { name: 'registrar_interes_crm', input: { email: 'a@b.com' } }, primero: hace(6) },
    { dialog_id: 'chat4', ts: hace(4), type: 'interes_internacional', detail: { motivo: 'enlace_pago' }, primero: hace(6) },
    { dialog_id: 'chat1', ts: hace(5), type: 'derivacion_internacional', detail: { pago: false }, primero: hace(72) },
    { dialog_id: 'chat2', ts: hace(7), type: 'seguimiento', detail: { internacional: true }, primero: hace(10) },
    { dialog_id: 'chat2', ts: hace(30), type: 'seguimiento', detail: { internacional: true }, primero: hace(10) },
    { dialog_id: 'chat1', ts: hace(5), type: 'seguimiento_respondido', detail: {}, primero: hace(72) },
  ];
  const r = calcularResumen(filas, AHORA);
  assert.equal(r.nuevos, 3);
  assert.equal(r.nuevosConContenido, 1);
  assert.equal(r.activos, 4);
  assert.equal(r.correos, 1);
  assert.equal(r.enlacesDePago, 1);
  assert.equal(r.consultas, 1);
  assert.equal(r.pagos, 0);
  assert.equal(r.recordatorios, 1, 'solo las últimas 24 h');
  assert.equal(r.respondidos, 1);
  assert.deepEqual(r.variantes, { A: { chats: 2, volvieron: 2 }, B: { chats: 1, volvieron: 0 } });

  const texto = textoResumen(r, 2, 7);
  assert.match(texto, /Chats nuevos: 3 \(1 escribieron algo más que el mensaje del anuncio\)/);
  assert.match(texto, /Interesados: 1 correo · 1 enlace de pago enviado · 0 pagos informados/);
  assert.match(texto, /2 sin responder \(escríbame «pendientes» para verlas\)/);
  assert.match(texto, /A \(el de siempre\) 2 chats, 100 % volvió a escribir · B \(corto\) 1 chats, 0 %/);
});

test('la propuesta para la ficha lista pregunta y respuesta y dice dónde agregarlas', () => {
  const t = textoPropuestaFicha([{ codigo: 'K7Q2', pregunta: '¿Hay factura GST?', respuesta: 'Sí, a nombre de la empresa', at: AHORA }]);
  assert.match(t, /respuestas que dio esta semana \(1\)/);
  assert.match(t, /1\. ¿Hay factura GST\? → Sí, a nombre de la empresa/);
  assert.match(t, /Conocimiento → Programa internacional/);
});

test('la prueba del primer mensaje alterna por número de chat', () => {
  assert.equal(varianteDePrimerMensaje('chat1608902'), 'A');
  assert.equal(varianteDePrimerMensaje('chat1608903'), 'B');
  assert.match(BLOQUE_PRIMER_MENSAJE_B, /at most 280 characters/);
  assert.match(BLOQUE_PRIMER_MENSAJE_B, /in English/);
});

test('el prompt pide decir que es en inglés, no describir fotos y no saludar con nombres de usuario', () => {
  const p = promptInternacional([{ apartado: 'Programme', contenido: 'Demo course, 12 weeks, in English.' }]);
  assert.match(p, /Say so in your first reply/);
  assert.match(p, /Never describe or comment on what a photo or image shows/);
  assert.match(p, /If it has digits, dots or underscores \(a username\), greet them without a name/);
  assert.match(p, /ask them kindly not to share personal documents here/);
});
