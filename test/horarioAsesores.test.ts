import { test } from 'node:test';
import assert from 'node:assert/strict';

// El bot atiende CUANDO NO HAY NADIE: noches, madrugadas, sábados y domingos. De lunes a viernes de
// 9:00 a 18:30 (hora de Chile) se aparta, porque ahí están los asesores.
//
// Todas las fechas son explícitas y en UTC: una prueba de horario que dependa del reloj del momento
// pasa o falla según la hora a la que alguien corra el suite, que es la peor clase de prueba.
process.env.MARCA = 'carver';
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

const { asesoresDisponibles, proximoFueraDeHorario, momentoEnChile, minutosDeHora } = await import(
  '../src/core/horarioAsesores'
);
const { config } = await import('../src/config');
const { proximoHorarioPermitido, horaEnChile } = await import('../src/ai/seguimiento');

// Chile en horario de INVIERNO (abril–septiembre) está en UTC-4; en verano, UTC-3.
const invierno = (utc: string) => new Date(`2026-07-${utc}Z`); // julio: UTC-4
const verano = (utc: string) => new Date(`2026-01-${utc}Z`); // enero: UTC-3

test('de lunes a viernes, entre 9:00 y 18:30, el bot se aparta', () => {
  // 2026-07-15 es miércoles. 13:00 UTC = 09:00 en Chile (UTC-4).
  assert.equal(asesoresDisponibles(invierno('15T13:00:00')), true, 'justo a las 9:00');
  assert.equal(asesoresDisponibles(invierno('15T17:00:00')), true, '13:00 en Chile');
  assert.equal(asesoresDisponibles(invierno('15T22:29:00')), true, '18:29, todavía hay gente');
});

test('a las 18:30 en punto el bot vuelve a atender', () => {
  // El cierre es exclusivo: 18:30 ya es del bot.
  assert.equal(asesoresDisponibles(invierno('15T22:30:00')), false, '18:30 exactas');
  assert.equal(asesoresDisponibles(invierno('15T23:00:00')), false, '19:00');
});

test('antes de las 9:00 y de madrugada atiende el bot', () => {
  assert.equal(asesoresDisponibles(invierno('15T12:59:00')), false, '08:59');
  assert.equal(asesoresDisponibles(invierno('15T06:00:00')), false, '02:00 de la madrugada');
});

test('sábado y domingo el bot atiende todo el día', () => {
  // 2026-07-18 sábado, 2026-07-19 domingo, ambos a mediodía de Chile.
  assert.equal(asesoresDisponibles(invierno('18T16:00:00')), false, 'sábado 12:00');
  assert.equal(asesoresDisponibles(invierno('19T16:00:00')), false, 'domingo 12:00');
});

test('el cambio de hora de Chile no corre el horario', () => {
  // Lo que un offset fijo de -3 rompería medio año: en invierno Chile es UTC-4.
  // 2026-01-14 es miércoles (verano, UTC-3): 12:00 UTC = 09:00 en Chile.
  assert.equal(asesoresDisponibles(verano('14T12:00:00')), true, 'verano, 09:00 en Chile');
  assert.equal(asesoresDisponibles(verano('14T11:59:00')), false, 'verano, 08:59 en Chile');
  // En invierno esa MISMA hora UTC es una hora antes en Chile.
  assert.equal(asesoresDisponibles(invierno('15T12:00:00')), false, 'invierno, 08:00 en Chile');
});

test('momentoEnChile devuelve el día y la hora locales, no los del servidor', () => {
  const m = momentoEnChile(invierno('15T17:30:00'));
  assert.equal(m.dia, 3, 'miércoles');
  assert.equal(m.minutos, 13 * 60 + 30, '13:30 en Chile');
});

test('proximoFueraDeHorario deja la fecha si ya está fuera, y corre al cierre si está dentro', () => {
  const deNoche = invierno('15T06:00:00'); // 02:00 en Chile
  assert.equal(proximoFueraDeHorario(deNoche).getTime(), deNoche.getTime(), 'de madrugada no se mueve');

  const enJornada = invierno('15T17:00:00'); // 13:00 en Chile
  const corrido = proximoFueraDeHorario(enJornada);
  assert.ok(corrido > enJornada, 'se corre hacia adelante');
  assert.equal(asesoresDisponibles(corrido), false, 'y cae fuera de la jornada');
  assert.equal(momentoEnChile(corrido).minutos, 18 * 60 + 30, 'justo a las 18:30');

  const finde = invierno('18T16:00:00'); // sábado
  assert.equal(proximoFueraDeHorario(finde).getTime(), finde.getTime(), 'el sábado no se corre nada');
});

test('con la regla desactivada el bot atiende a toda hora, como antes', () => {
  config.horarioAsesoresActivo = false;
  assert.equal(asesoresDisponibles(invierno('15T17:00:00')), false, 'miércoles 13:00 y aun así atiende');
  config.horarioAsesoresActivo = true;
});

test('una hora mal escrita en la configuración no apaga el bot', () => {
  // Un typo en una variable de entorno no puede dejar a nadie sin atención ni apagar el bot todo el
  // día: se cae al valor de reserva.
  assert.equal(minutosDeHora('18:30', 0), 18 * 60 + 30);
  assert.equal(minutosDeHora('9:00', 0), 9 * 60);
  assert.equal(minutosDeHora('', 555), 555, 'vacío');
  assert.equal(minutosDeHora('18.30', 555), 555, 'con punto');
  assert.equal(minutosDeHora('abc', 555), 555);
  assert.equal(minutosDeHora('25:99', 555), 555, 'fuera de rango');
});

test('los días de atención son configurables', () => {
  const antes = config.horarioAsesoresDias;
  config.horarioAsesoresDias = [6]; // solo sábado
  assert.equal(asesoresDisponibles(invierno('18T16:00:00')), true, 'sábado 12:00 ahora SÍ tiene asesores');
  assert.equal(asesoresDisponibles(invierno('15T17:00:00')), false, 'miércoles ya no');
  config.horarioAsesoresDias = antes;
});

// ── Las dos ventanas a la vez ────────────────────────────────────────────────────────────────────
// Un recordatorio tiene que cumplir DOS condiciones: no salir de madrugada (ventana 9:00–21:00) y no
// salir mientras hay asesores (lun–vie 9:00–18:30). Corregir una puede romper la otra: salir de la
// jornada a las 18:30 cae dentro de la ventana, pero correr al día siguiente a las 9:00 vuelve a
// caer en jornada. Entre semana solo queda la franja 18:30–21:00.
test('un recordatorio de media tarde se corre al cierre de la jornada, no al día siguiente', () => {
  const miercoles13 = invierno('15T17:00:00'); // miércoles 13:00 en Chile
  const r = proximoHorarioPermitido(miercoles13);
  assert.equal(asesoresDisponibles(r), false, 'fuera del horario de asesores');
  const h = horaEnChile(r);
  assert.ok(h >= config.seguimientoHoraInicio && h < config.seguimientoHoraFin, `dentro de la ventana (quedó a las ${h})`);
  assert.equal(momentoEnChile(r).minutos, 18 * 60 + 30, 'justo al cierre');
});

test('un recordatorio de madrugada entre semana espera hasta DESPUÉS de la jornada', () => {
  // Las 2:00 están fuera de la ventana de seguimiento; correrlo a las 9:00 lo metería en jornada.
  const miercoles2am = invierno('15T06:00:00');
  const r = proximoHorarioPermitido(miercoles2am);
  assert.equal(asesoresDisponibles(r), false);
  const h = horaEnChile(r);
  assert.ok(h >= config.seguimientoHoraInicio && h < config.seguimientoHoraFin, `quedó a las ${h}`);
  assert.ok(h >= 18, `no puede quedar en plena jornada (quedó a las ${h})`);
});

test('el fin de semana el recordatorio sale a la hora normal', () => {
  const sabado12 = invierno('18T16:00:00');
  const r = proximoHorarioPermitido(sabado12);
  assert.equal(r.getTime(), sabado12.getTime(), 'no se mueve: no hay asesores y está dentro de la ventana');
});

test('un recordatorio de las 20:00 entre semana sale tal cual', () => {
  const miercoles20 = invierno('16T00:00:00'); // miércoles 20:00 en Chile
  assert.equal(momentoEnChile(miercoles20).minutos, 20 * 60, 'control: son las 20:00');
  const r = proximoHorarioPermitido(miercoles20);
  assert.equal(r.getTime(), miercoles20.getTime());
});
