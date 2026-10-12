import { test } from 'node:test';
import assert from 'node:assert/strict';

// Caducidad de la información comercial. Los precios y el "cupos completos hasta marzo de 2027" se
// validaron una vez con la dirección y quedaron congelados. Cuando cambien, nadie va a avisarle al
// bot y éste los seguirá afirmando con total seguridad — la peor forma de equivocarse frente a
// alguien que está decidiendo dónde gastar miles de dólares.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

const { estadoVigencia, conAvisoDeVigencia } = await import('../src/core/vigencia');
const { config } = await import('../src/config');

test('sin fecha configurada todo sigue como antes', () => {
  config.condicionesVigenciaHasta = '';
  assert.equal(estadoVigencia().vigente, true);
  const r = conAvisoDeVigencia({ programa: 'x', nota: 'original' });
  assert.equal(r.nota, 'original', 'no toca nada');
  assert.equal((r as any).avisoVigencia, undefined);
});

test('antes de la fecha está vigente', () => {
  config.condicionesVigenciaHasta = '2026-12-31';
  assert.equal(estadoVigencia(new Date('2026-10-12T12:00:00Z')).vigente, true);
});

test('el día de la fecha todavía está vigente: cuenta el día entero', () => {
  config.condicionesVigenciaHasta = '2026-10-12';
  assert.equal(estadoVigencia(new Date('2026-10-12T20:00:00Z')).vigente, true);
});

test('pasada la fecha deja de estar vigente y cuenta los días', () => {
  config.condicionesVigenciaHasta = '2026-10-01';
  const v = estadoVigencia(new Date('2026-10-12T12:00:00Z'));
  assert.equal(v.vigente, false);
  assert.ok(v.diasVencida! >= 10 && v.diasVencida! <= 12);
});

test('vencida, el precio SIGUE saliendo pero marcado como referencia', () => {
  // Callar el precio sería peor: lo más probable es que siga siendo correcto, y dejar sin respuesta
  // a quien pregunta cuánto cuesta es justamente lo que el bot vino a resolver.
  config.condicionesVigenciaHasta = '2026-01-01';
  const r = conAvisoDeVigencia({ programa: 'Maestría', arancel: '$2.300', nota: 'tres formas de pago' }, new Date('2026-10-12T12:00:00Z'));
  assert.equal(r.arancel, '$2.300', 'el valor no se oculta');
  assert.match(r.avisoVigencia, /REFERENCIA/);
  assert.match(r.nota, /REFERENCIA/);
  assert.match(r.nota, /tres formas de pago/, 'conserva la nota original');
});

test('la advertencia prohíbe cerrar una matrícula sobre esas cifras', () => {
  config.condicionesVigenciaHasta = '2026-01-01';
  const r = conAvisoDeVigencia({ nota: '' }, new Date('2026-10-12T12:00:00Z'));
  assert.match(r.avisoVigencia, /NUNCA/);
  assert.match(r.avisoVigencia, /confirmar/i);
  config.condicionesVigenciaHasta = '';
});

test('una fecha mal escrita no apaga el bot ni lo pone en modo advertencia', () => {
  config.condicionesVigenciaHasta = 'marzo de 2027';
  assert.equal(estadoVigencia().vigente, true, 'ante una configuración inválida, comportamiento previo');
  config.condicionesVigenciaHasta = '';
});
