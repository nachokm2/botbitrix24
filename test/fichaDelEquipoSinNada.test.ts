import { test } from 'node:test';
import assert from 'node:assert/strict';

// Sin ficha del punto de entrada y con una variable que no sirve (http, no https), no hay ficha del
// equipo: el bot sigue como antes, sin inventar un enlace.
process.env.MARCA = 'carver';
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.BITRIX_DERIVAR_A = '62741';
process.env.ASESORES_CONTACTO = JSON.stringify([{ id: 166867, formulario: 'https://carver.university/lp/forms/form-carver-asesora/' }]);
process.env.FICHA_POSTULACION_DEFECTO = 'http://carver.university/lp/forms/form-carver-general/';

const { fichaDelEquipo, fichaParaElTurno } = await import('../src/core/fichaPostulacion');

test('una variable que no es https no sirve', () => {
  assert.equal(fichaDelEquipo(), undefined);
  assert.equal(fichaParaElTurno(null), undefined);
  assert.equal(fichaParaElTurno({}), undefined);
  assert.equal(fichaParaElTurno({ formulario: 'https://carver.university/lp/forms/form-carver-asesora/' }), 'https://carver.university/lp/forms/form-carver-asesora/');
});
