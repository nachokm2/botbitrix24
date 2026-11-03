import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Arreglos que salieron de leer las conversaciones de Carver del 25-10 al 03-11-2026 (221 chats).
process.env.MARCA = 'carver';
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';

const respuestas: string[] = [];
let llamadasModelo = 0;
mock.module('../src/ai/client.ts', {
  namedExports: {
    anthropic: {
      messages: {
        create: async () => {
          llamadasModelo++;
          return { content: [{ type: 'text', text: respuestas.shift() ?? '' }], usage: {} };
        },
      },
    },
    REASONER: 'claude-test-sonnet',
    CLASSIFIER: 'claude-test-haiku',
  },
});
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: async () => ({}),
    callCrm: async () => ({}),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: [], total: 0, next: null }),
    callWebhook: async () => ({}),
  },
});

const { detallePrograma } = await import('../src/core/catalogTool');
const { buscarCondicionesCarver: buscarCondiciones } = await import('../src/core/condicionesCarver');
const { aplicarGuardian } = await import('../src/ai/agentLoop');
const { transcripcionesConFuentes } = await import('../src/store/db');

test('el MBA se encuentra aunque el modelo lo escriba con paréntesis (6 consultas fallidas)', () => {
  for (const nombre of ['Maestría en Administración de Empresas (MBA)', 'maestria en administracion de empresas mba', 'MBA']) {
    const r: any = detallePrograma({ nombre }, 'full');
    assert.equal(r.ok, true, nombre);
    assert.equal(r.detalle.nombre, 'Maestría en Administración de Empresas MBA');
  }
  assert.equal((detallePrograma({ nombre: 'Doctorado en Astronomía' }, 'full') as any).ok, false, 'lo que no existe sigue sin existir');
});

test('el contado de la licenciatura se dice por año, no como un único pago de USD 2.340', () => {
  const r: any = buscarCondiciones('Licenciatura en Psicología');
  const nota = String(r.formasDePago?.contado?.nota ?? '');
  assert.match(nota, /USD 585 al año durante 4 años/);
  assert.match(nota, /Nunca lo presentes como un único pago de USD 2340/);
  const maestria: any = buscarCondiciones('Maestría en Inteligencia Artificial');
  assert.doesNotMatch(String(maestria.formasDePago?.contado?.nota ?? ''), /al año/, 'el contado de una maestría es un solo pago');
});

const turno = { mensajeCliente: 'quiero saber más', history: [], mensajesDelTurno: [], simulacion: true };

test('una respuesta que tutea se reescribe de usted, con las mismas cifras', async () => {
  respuestas.push('¿Le cuento cómo son las clases en vivo? Con la beca son USD 150 al mes.');
  const r = await aplicarGuardian('¿Te cuento cómo son las clases en vivo? Con la beca son USD 150 al mes.', turno);
  assert.equal(r, '¿Le cuento cómo son las clases en vivo? Con la beca son USD 150 al mes.');
});

test('si la versión de usted pierde una cifra o sigue tuteando, queda la original', async () => {
  respuestas.push('¿Le cuento cómo son las clases en vivo? Tiene beca.');
  assert.match(await aplicarGuardian('¿Te cuento cómo son las clases? Son USD 150 al mes.', turno), /USD 150/);
  respuestas.push('¿Quieres que le cuente más? Son USD 150 al mes.');
  assert.equal(await aplicarGuardian('¿Quieres que te cuente más? Son USD 150 al mes.', turno), '¿Quieres que te cuente más? Son USD 150 al mes.');
});

test('una respuesta de usted no pasa por el modelo', async () => {
  const antes = llamadasModelo;
  await aplicarGuardian('¿Le cuento cómo son las clases en vivo? El docente imparte cada sesión.', turno);
  assert.equal(llamadasModelo, antes);
});

test('el auditor ve qué fuentes consultó el bot antes de cada respuesta', () => {
  const [c] = transcripcionesConFuentes([
    { dialog_id: 'chat1', ts: '2026-11-02T10:00:00Z', type: 'tool_call', crm_entity: null, detail: { name: 'consultar_condiciones_comerciales', input: {}, ok: true } },
    { dialog_id: 'chat1', ts: '2026-11-02T10:00:01Z', type: 'tool_call', crm_entity: null, detail: { name: 'consultar_informacion_institucional', input: { tema: 'reconocimiento_titulo' }, ok: true } },
    { dialog_id: 'chat1', ts: '2026-11-02T10:00:02Z', type: 'turn', crm_entity: 'deal#1', detail: { message: '¿Cuánto cuesta y sirve en Perú?', reply: 'Con la beca son USD 150 al mes; en Perú se reconoce ante SUNEDU.' } },
    { dialog_id: 'chat1', ts: '2026-11-02T10:05:00Z', type: 'turn', crm_entity: null, detail: { message: 'Gracias', reply: 'A usted.' } },
  ]);
  assert.equal(c.turnos, 2);
  assert.equal(c.crmEntity, 'deal#1');
  assert.equal(
    c.texto,
    'Cliente: ¿Cuánto cuesta y sirve en Perú?\n' +
      '[Fuentes verificadas que consultó el bot antes de responder: precios, becas y formas de pago; conocimiento institucional (reconocimiento_titulo)]\n' +
      'Bot: Con la beca son USD 150 al mes; en Perú se reconoce ante SUNEDU.\n' +
      'Cliente: Gracias\nBot: A usted.',
  );
});
