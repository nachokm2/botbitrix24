import { test } from 'node:test';
import assert from 'node:assert/strict';

// Ficha de postulación cuando la negociación no tiene una propia (core/fichaPostulacion.ts). Entre el
// 17 y el 24-11-2026, 241 de 502 chats de Carver tenían un responsable sin ficha utilizable y el bot
// prometía «te la envío mañana a las 9:00» sin que nadie lo hiciera. Los enlaces son sintéticos.
process.env.MARCA = 'carver';
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.BITRIX_DERIVAR_A = '62741';
process.env.ASESORES_CONTACTO = JSON.stringify([
  { id: 166867, formulario: 'https://carver.university/lp/forms/form-carver-asesora/' },
  { id: 62741, formulario: 'https://carver.university/lp/forms/form-carver-entrada/' },
]);
process.env.FICHA_POSTULACION_DEFECTO = 'https://carver.university/lp/forms/form-carver-general/';

const { fichaDelEquipo, fichaParaElTurno, bloqueFichaDelEquipo } = await import('../src/core/fichaPostulacion');

test('con la ficha del punto de entrada cargada, esa es la del equipo (antes que la variable)', () => {
  assert.equal(fichaDelEquipo(), 'https://carver.university/lp/forms/form-carver-entrada/');
});

test('el asesor con ficha propia usa la suya; el que no la tiene, la del equipo', () => {
  assert.equal(fichaParaElTurno({ formulario: 'https://carver.university/lp/forms/form-carver-asesora/' }), 'https://carver.university/lp/forms/form-carver-asesora/');
  assert.equal(fichaParaElTurno({}), 'https://carver.university/lp/forms/form-carver-entrada/');
  // Sin identidad (negociación sin responsable, o de otro embudo) también.
  assert.equal(fichaParaElTurno(null), 'https://carver.university/lp/forms/form-carver-entrada/');
  assert.equal(fichaParaElTurno(undefined), 'https://carver.university/lp/forms/form-carver-entrada/');
});

test('el bloque del prompt usa la misma frase que la ficha del asesor', () => {
  const b = bloqueFichaDelEquipo('https://carver.university/lp/forms/form-carver-entrada/');
  assert.match(b, /Tu FICHA DE POSTULACIÓN es https:\/\/carver\.university\/lp\/forms\/form-carver-entrada\//);
  assert.match(b, /nunca otra/);
});
