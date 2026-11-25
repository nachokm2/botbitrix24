import { test } from 'node:test';
import assert from 'node:assert/strict';

// La ficha del equipo cuando el punto de entrada NO tiene la suya en ASESORES_CONTACTO: manda la
// variable FICHA_POSTULACION_DEFECTO, y solo si es https (un enlace sin cifrar no se le da a nadie).
process.env.MARCA = 'carver';
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.BITRIX_DERIVAR_A = '62741';
process.env.ASESORES_CONTACTO = JSON.stringify([{ id: 166867, formulario: 'https://carver.university/lp/forms/form-carver-asesora/' }]);
process.env.FICHA_POSTULACION_DEFECTO = 'https://carver.university/lp/forms/form-carver-general/';

const { fichaDelEquipo, fichaParaElTurno } = await import('../src/core/fichaPostulacion');

test('sin la ficha del punto de entrada, sale la de la variable', () => {
  assert.equal(fichaDelEquipo(), 'https://carver.university/lp/forms/form-carver-general/');
  assert.equal(fichaParaElTurno(null), 'https://carver.university/lp/forms/form-carver-general/');
  assert.equal(fichaParaElTurno({ formulario: 'https://carver.university/lp/forms/form-carver-asesora/' }), 'https://carver.university/lp/forms/form-carver-asesora/');
});
