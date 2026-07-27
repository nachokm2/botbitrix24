import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Fase 2: clasificador de cierre. Camino determinístico (endedReason, sin IA) + camino IA (Haiku mockeado).
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

let impl: (args: any) => Promise<any> = async () => ({ content: [{ type: 'text', text: '' }], usage: {} });
const createCalls: any[] = [];
mock.module('../src/ai/client.ts', {
  namedExports: {
    anthropic: { messages: { create: (args: any) => (createCalls.push(args), impl(args)) } },
    REASONER: 'claude-test-sonnet',
    CLASSIFIER: 'claude-test-haiku',
  },
});

const {
  derivarAccion, clasificarPorEndedReason, clasificarCierreIA, clasificarCierre,
} = await import('../src/ai/clasificadorCierre');

const textResp = (text: string) => ({ content: [{ type: 'text', text }], usage: {} });

// ── derivarAccion (puro) ──
test('derivarAccion: Muy interesado → escalar/alta', () => {
  assert.deepEqual(derivarAccion('Muy interesado', 90), { prioridad: 'alta', siguienteAccion: 'escalar' });
});
test('derivarAccion: No interesado → cerrar/baja', () => {
  assert.deepEqual(derivarAccion('No interesado', 0), { prioridad: 'baja', siguienteAccion: 'cerrar' });
});
test('derivarAccion: Requiere seguimiento escala si supera el umbral', () => {
  assert.equal(derivarAccion('Requiere seguimiento', 80).siguienteAccion, 'escalar');
  assert.equal(derivarAccion('Requiere seguimiento', 40).siguienteAccion, 'callback');
});

// ── clasificarPorEndedReason (puro, sin IA) ──
test('endedReason: no contesta', () => {
  const c = clasificarPorEndedReason('customer-did-not-answer');
  assert.equal(c?.clasificacion, 'No contesta');
  assert.equal(c?.outcomeCode, 'no_answer');
  assert.equal(c?.siguienteAccion, 'reintentar');
  assert.equal(c?.leadScore, 0);
});
test('endedReason: buzón y ocupado', () => {
  assert.equal(clasificarPorEndedReason('voicemail')?.outcomeCode, 'voicemail');
  assert.equal(clasificarPorEndedReason('customer-busy')?.outcomeCode, 'busy');
});
test('endedReason: número inválido → cerrar', () => {
  const c = clasificarPorEndedReason('twilio-error-21211-invalid-number');
  assert.equal(c?.clasificacion, 'Número incorrecto');
  assert.equal(c?.outcomeCode, 'invalid_number');
  assert.equal(c?.siguienteAccion, 'cerrar');
});
test('endedReason: conversación real → null (lo decide la IA)', () => {
  assert.equal(clasificarPorEndedReason('customer-ended-call'), null);
  assert.equal(clasificarPorEndedReason('assistant-ended-call'), null);
  assert.equal(clasificarPorEndedReason(''), null);
});

// ── clasificarCierreIA (Haiku mockeado) ──
test('clasificarCierreIA: parsea el JSON y deriva escalar', async () => {
  impl = async () => textResp(JSON.stringify({
    clasificacion: 'Interesado', leadScore: 78,
    factores: { interes: 80, intencion: 75, urgencia: 60, presupuesto: 50, disponibilidad: 70, participacion: 85 },
    objeciones: ['precio'], temas: ['modalidad', 'arancel'], resumen: 'Prospecto interesado, consultó por el arancel.',
  }));
  const c = await clasificarCierreIA('agente: hola... cliente: sí, me interesa el magíster');
  assert.equal(c?.clasificacion, 'Interesado');
  assert.equal(c?.leadScore, 78);
  assert.equal(c?.siguienteAccion, 'escalar');
  assert.equal(c?.prioridad, 'alta');
  assert.equal(c?.outcomeCode, 'answered');
  assert.deepEqual(c?.objeciones, ['precio']);
});
test('clasificarCierreIA: respuesta basura → null', async () => {
  impl = async () => textResp('no soy json');
  assert.equal(await clasificarCierreIA('conversación cualquiera'), null);
});

// ── clasificarCierre (combinado) ──
test('clasificarCierre: no-contacto NO invoca al modelo', async () => {
  createCalls.length = 0;
  const c = await clasificarCierre({ endedReason: 'customer-did-not-answer' });
  assert.equal(c.outcomeCode, 'no_answer');
  assert.equal(createCalls.length, 0, 'el camino determinístico no llama a la IA');
});
test('clasificarCierre: conversación real usa la IA con la transcripción', async () => {
  createCalls.length = 0;
  impl = async () => textResp(JSON.stringify({
    clasificacion: 'Muy interesado', leadScore: 92,
    factores: { interes: 95, intencion: 95, urgencia: 80, presupuesto: 70, disponibilidad: 80, participacion: 90 },
    objeciones: [], temas: ['matrícula'], resumen: 'Quiere matricularse; derivar a asesor.',
  }));
  const c = await clasificarCierre({ endedReason: 'customer-ended-call', transcript: 'cliente: quiero matricularme ya' });
  assert.equal(createCalls.length, 1, 'invoca a la IA una vez');
  assert.equal(c.clasificacion, 'Muy interesado');
  assert.equal(c.siguienteAccion, 'escalar');
});
