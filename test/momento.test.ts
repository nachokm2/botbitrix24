import { test } from 'node:test';
import assert from 'node:assert/strict';

// Qué día es y cuándo vuelve el equipo (core/momento.ts). Caso real: el bot prometió "le respondo a la
// brevedad" un viernes con la asesora ya fuera de horario, y la respuesta llegó el lunes.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

const { bloqueMomento, proximaJornada, equipoTrabajando } = await import('../src/core/momento');

const H = (extra: Record<string, unknown> = {}) =>
  ({
    asesoresActivo: false, // la regla del bot apagada no cambia el horario de las personas
    asesoresDias: [1, 2, 3, 4, 5],
    asesoresInicio: '09:00',
    asesoresFin: '18:30',
    feriados: [],
    ritmoMinS: 0,
    ritmoMaxS: 0,
    automaticosHoraInicio: 9,
    automaticosHoraFin: 21,
    ...extra,
  }) as any;
// Chile en octubre y noviembre de 2026 está en UTC-3.
const chile = (local: string) => new Date(`${local}-03:00`);

test('sábado por la tarde: el equipo vuelve el lunes, y el bloque lo dice', () => {
  const t = chile('2026-10-31T15:10:00');
  assert.equal(equipoTrabajando(t, H()), false);
  assert.equal(proximaJornada(t, H()), 'el lunes 2 de noviembre desde las 9:00');
  const b = bloqueMomento(t, H());
  assert.match(b, /hoy es sábado 31 de octubre/);
  assert.match(b, /de lunes a viernes de 9:00 a 18:30/);
  assert.match(b, /FUERA de horario.*el lunes 2 de noviembre desde las 9:00/);
  assert.match(b, /nunca "a la brevedad"/);
});

test('viernes después del cierre: también el lunes', () => {
  assert.equal(proximaJornada(chile('2026-10-30T19:00:00'), H()), 'el lunes 2 de noviembre desde las 9:00');
});

test('domingo de noche: "mañana"', () => {
  assert.equal(proximaJornada(chile('2026-11-01T20:00:00'), H()), 'mañana lunes 2 de noviembre desde las 9:00');
});

test('día hábil antes de abrir: "hoy desde las 9:00"', () => {
  assert.equal(proximaJornada(chile('2026-11-02T07:30:00'), H()), 'hoy desde las 9:00');
});

test('en horario: no hay próxima jornada y puede verse hoy mismo', () => {
  const t = chile('2026-10-30T13:00:00');
  assert.equal(equipoTrabajando(t, H()), true);
  assert.equal(proximaJornada(t, H()), null);
  assert.match(bloqueMomento(t, H()), /en horario: .*hoy mismo/);
});

test('un feriado se salta', () => {
  const h = H({ feriados: [{ fecha: '2026-11-02', nombre: 'Feriado de prueba' }] });
  assert.equal(proximaJornada(chile('2026-10-31T15:10:00'), h), 'el martes 3 de noviembre desde las 9:00');
});

test('sin minutos: el bloque no cambia en toda la tarde (no rompe la caché del prompt)', () => {
  assert.equal(bloqueMomento(chile('2026-10-31T15:10:00'), H()), bloqueMomento(chile('2026-10-31T22:59:00'), H()));
});

test('sin días de trabajo configurados, solo dice la fecha', () => {
  const b = bloqueMomento(chile('2026-10-31T15:10:00'), H({ asesoresDias: [] }));
  assert.match(b, /hoy es sábado 31 de octubre\.$/);
});
