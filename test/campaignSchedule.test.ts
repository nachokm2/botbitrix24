import { test } from 'node:test';
import assert from 'node:assert/strict';

// Fase 4: calendario (TZ Santiago) y política de reintentos — partes PURAS.
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

const { wallClock, zonedToUtc, esDiaHabil, olaActual, dentroDeVentana } = await import('../src/campaign/calendar');
const { planificarIntento } = await import('../src/campaign/retryPolicy');
import type { CampaignAgenda } from '../src/campaign/programRegistry';

const agenda: CampaignAgenda = {
  tz: 'America/Santiago', waves: ['09:15', '14:15', '18:45'],
  maxPorDia: 3, maxDias: 3, maxTotal: 9,
  ventanaHabil: ['09:00', '19:00'], diasHabiles: [1, 2, 3, 4, 5], feriados: ['2026-09-18'],
};

// ── calendario ──
test('calendar: round-trip zonedToUtc → wallClock conserva la hora de pared', () => {
  const utc = zonedToUtc(2026, 7, 25, 14, 15, 'America/Santiago');
  const wc = wallClock(utc, 'America/Santiago');
  assert.equal(wc.ymd, '2026-07-25');
  assert.equal(wc.hh, 14);
  assert.equal(wc.mm, 15);
});

test('calendar: round-trip también en horario de verano (enero)', () => {
  const utc = zonedToUtc(2026, 1, 15, 18, 45, 'America/Santiago');
  const wc = wallClock(utc, 'America/Santiago');
  assert.equal(wc.hh, 18);
  assert.equal(wc.mm, 45);
  assert.equal(wc.ymd, '2026-01-15');
});

test('calendar: olaActual mapea las 3 olas', () => {
  assert.equal(olaActual(9, 15, agenda.waves), 'W1');
  assert.equal(olaActual(14, 15, agenda.waves), 'W2');
  assert.equal(olaActual(18, 45, agenda.waves), 'W3');
  assert.equal(olaActual(10, 0, agenda.waves), null);
});

test('calendar: esDiaHabil respeta días de semana y feriados', () => {
  assert.equal(esDiaHabil('2026-07-20', 1, agenda), true); // lunes
  assert.equal(esDiaHabil('2026-07-19', 0, agenda), false); // domingo
  assert.equal(esDiaHabil('2026-09-18', 5, agenda), false); // feriado (viernes)
});

test('calendar: dentroDeVentana', () => {
  assert.equal(dentroDeVentana(9, 15, agenda.ventanaHabil), true);
  assert.equal(dentroDeVentana(8, 59, agenda.ventanaHabil), false);
  assert.equal(dentroDeVentana(19, 1, agenda.ventanaHabil), false);
});

// ── política de reintentos ──
test('retry: target nuevo → primer intento del día 1', () => {
  const p = planificarIntento({ attemptsTotal: 0, attemptsToday: 0, dayIndex: 1, todayDate: null }, agenda, '2026-07-27', 'iso');
  assert.equal(p.llamar, true);
  assert.equal(p.attemptNo, 1);
  assert.equal(p.patch.dayIndex, 1);
  assert.equal(p.patch.attemptsToday, 1);
  assert.equal(p.patch.attemptsTotal, 1);
  assert.equal(p.patch.status, 'LLAMANDO');
});

test('retry: alcanzó el tope diario → no llama (no agotado)', () => {
  const p = planificarIntento({ attemptsTotal: 2, attemptsToday: 3, dayIndex: 1, todayDate: '2026-07-27' }, agenda, '2026-07-27', 'iso');
  assert.equal(p.llamar, false);
  assert.equal(p.agotado, false);
});

test('retry: nuevo día resetea el conteo diario y avanza el índice de día', () => {
  const p = planificarIntento({ attemptsTotal: 3, attemptsToday: 3, dayIndex: 1, todayDate: '2026-07-27' }, agenda, '2026-07-28', 'iso');
  assert.equal(p.llamar, true);
  assert.equal(p.patch.dayIndex, 2);
  assert.equal(p.patch.attemptsToday, 1);
  assert.equal(p.attemptNo, 4);
});

test('retry: supera los 3 días → agotado', () => {
  const p = planificarIntento({ attemptsTotal: 9, attemptsToday: 3, dayIndex: 3, todayDate: '2026-07-29' }, agenda, '2026-07-30', 'iso');
  assert.equal(p.llamar, false);
  assert.equal(p.agotado, true);
});

test('retry: alcanzó 9 intentos → agotado', () => {
  const p = planificarIntento({ attemptsTotal: 9, attemptsToday: 1, dayIndex: 3, todayDate: '2026-07-29' }, agenda, '2026-07-29', 'iso');
  assert.equal(p.agotado, true);
});
