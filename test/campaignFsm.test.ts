import { test } from 'node:test';
import assert from 'node:assert/strict';

// Fase 3: máquina de estados (siguienteEstado) y asignación de asesor (round-robin) — partes PURAS.
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

const { siguienteEstado } = await import('../src/campaign/stateMachine');
const { asesorEnIndice, elegirAsesor } = await import('../src/campaign/assignment');
import type { Cierre, CierreCategoria, SiguienteAccion } from '../src/ai/clasificadorCierre';

function mkCierre(clasificacion: CierreCategoria, siguienteAccion: SiguienteAccion, leadScore = 0): Cierre {
  return {
    clasificacion, leadScore, siguienteAccion,
    factores: { interes: 0, intencion: 0, urgencia: 0, presupuesto: 0, disponibilidad: 0, participacion: 0 },
    objeciones: [], temas: [], resumen: '', prioridad: 'baja',
    outcomeCode: siguienteAccion === 'reintentar' ? 'no_answer' : 'answered',
  };
}

// ── siguienteEstado ──
test('FSM: escalar → CALIFICADO con escalar=true', () => {
  assert.deepEqual(siguienteEstado(1, mkCierre('Interesado', 'escalar', 78), 9), { status: 'CALIFICADO', escalar: true });
});
test('FSM: no interesado → NO_INTERESADO', () => {
  assert.deepEqual(siguienteEstado(1, mkCierre('No interesado', 'cerrar'), 9), { status: 'NO_INTERESADO', escalar: false });
});
test('FSM: número incorrecto → NUMERO_INVALIDO', () => {
  assert.deepEqual(siguienteEstado(1, mkCierre('Número incorrecto', 'cerrar'), 9), { status: 'NUMERO_INVALIDO', escalar: false });
});
test('FSM: no es el titular → NO_TITULAR', () => {
  assert.deepEqual(siguienteEstado(1, mkCierre('No es el titular', 'reintentar'), 9), { status: 'NO_TITULAR', escalar: false });
});
test('FSM: no contesta con intentos disponibles → SIN_RESPUESTA', () => {
  assert.equal(siguienteEstado(3, mkCierre('No contesta', 'reintentar'), 9).status, 'SIN_RESPUESTA');
});
test('FSM: no contesta agotado (>= maxTotal) → AGOTADO', () => {
  assert.equal(siguienteEstado(9, mkCierre('No contesta', 'reintentar'), 9).status, 'AGOTADO');
});
test('FSM: callback y nurture', () => {
  assert.equal(siguienteEstado(1, mkCierre('Requiere seguimiento', 'callback'), 9).status, 'CALLBACK');
  assert.equal(siguienteEstado(1, mkCierre('Más adelante', 'nurture'), 9).status, 'SEGUIMIENTO');
});
test('FSM: opt-out fuerza NO_INTERESADO aunque la acción fuese otra', () => {
  assert.deepEqual(siguienteEstado(1, mkCierre('Interesado', 'escalar', 90), 9, true), { status: 'NO_INTERESADO', escalar: false });
});

// ── asignación ──
test('asesorEnIndice: round-robin sobre el pool (tolera negativos)', () => {
  const pool = [3515, 709431];
  assert.equal(asesorEnIndice(pool, 0), 3515);
  assert.equal(asesorEnIndice(pool, 1), 709431);
  assert.equal(asesorEnIndice(pool, 2), 3515);
  assert.equal(asesorEnIndice(pool, -1), 709431);
  assert.equal(asesorEnIndice([], 0), 0);
});

test('elegirAsesor: estrategia fixed devuelve el fallback', async () => {
  const pc: any = { code: 'T', asesor: { estrategia: 'fixed', pool: [1, 2], fallbackUserId: 99 } };
  assert.equal(await elegirAsesor(pc), 99);
});
test('elegirAsesor: estrategia owner usa el responsable del deal', async () => {
  const pc: any = { code: 'T', asesor: { estrategia: 'owner', pool: [1, 2], fallbackUserId: 99 } };
  assert.equal(await elegirAsesor(pc, 42), 42);
});
test('elegirAsesor: round-robin reparte dentro del pool', async () => {
  const pc: any = { code: 'RR_TEST', asesor: { estrategia: 'round-robin', pool: [3515, 709431], fallbackUserId: 0 } };
  const elegidos = new Set<number>();
  for (let i = 0; i < 4; i++) elegidos.add(await elegirAsesor(pc));
  // En 4 vueltas debe haber tocado ambos asesores del pool.
  assert.deepEqual([...elegidos].sort((a, b) => a - b), [3515, 709431]);
});
