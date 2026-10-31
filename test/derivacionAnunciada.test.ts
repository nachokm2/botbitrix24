import { test } from 'node:test';
import assert from 'node:assert/strict';

// El guardián no deja anunciar una derivación (core/guardRespuesta.ts, regla 2c). Caso real del
// 31-10-2026: "Jimena, lo he escalado al equipo de soporte", dicho por el bot que habla como su asesor.
process.env.NODE_ENV = 'test';

const { guardarRespuesta, COMPROMISO_EN_PRIMERA_PERSONA } = await import('../src/core/guardRespuesta');

const ctx = (extra: Record<string, unknown> = {}) => ({
  mensajeCliente: 'hola',
  respuestasPrevias: [],
  urlsPermitidas: [],
  maxCaracteres: 10_000,
  derivacionInterna: true,
  ...extra,
});

test('el anuncio se cambia por el compromiso en primera persona y el resto se conserva', () => {
  const r = guardarRespuesta(
    'Jimena, lo he escalado al equipo de soporte. Mientras tanto, puede escribir a admission@carver.university.',
    ctx(),
  );
  assert.ok(r.cambios.includes('derivacion_anunciada'));
  assert.equal(r.texto, `${COMPROMISO_EN_PRIMERA_PERSONA} Mientras tanto, puede escribir a admission@carver.university.`);
});

test('también "un asesor lo contactará" y "le conecto con un asesor"; si hay dos, queda un solo compromiso', () => {
  const r = guardarRespuesta('Perfecto. Un asesor lo contactará mañana. También puedo conectarlo con otro equipo.', ctx());
  assert.equal(r.texto, `Perfecto. ${COMPROMISO_EN_PRIMERA_PERSONA}`);
});

test('sin derivación interna (Postgrados) no se toca nada', () => {
  const t = 'Su asesor lo contactará a la brevedad.';
  assert.equal(guardarRespuesta(t, ctx({ derivacionInterna: false })).texto, t);
});

test('no confunde lo que no es un anuncio', () => {
  for (const t of [
    'Si lo prefiere, puede hablar con un asesor por este mismo chat.',
    '¿Le gustaría conocer los valores y las formas de pago?',
    'El equipo académico acompaña a cada estudiante durante el programa.',
  ]) {
    assert.equal(guardarRespuesta(t, ctx()).texto, t, t);
  }
});
