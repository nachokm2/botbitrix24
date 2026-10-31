import { test } from 'node:test';
import assert from 'node:assert/strict';

// Lo que el bot promete y lo que el cliente quiere hacer (core/promesas.ts). Las frases de las pruebas
// positivas son respuestas reales de producción del 30 y 31 de octubre de 2026.
process.env.NODE_ENV = 'test';

const { promesaDeSeguimiento, intencionDePago } = await import('../src/core/promesas');

test('detecta las promesas que salieron en producción', () => {
  const jimena =
    'Lo que puedo confirmarle es que el próximo ciclo disponible arranca el 23 de noviembre.\n\nPara hacer el cambio de fecha en su contrato, ' +
    'lo confirmo con el área de admisiones y le respondo por acá a la brevedad. ¿Le parece bien ese inicio en noviembre?';
  assert.match(promesaDeSeguimiento(jimena) ?? '', /lo confirmo con el área de admisiones/);
  assert.ok(promesaDeSeguimiento('Quedo atento al proceso y le aviso por acá en cuanto esté todo listo.'));
  assert.ok(promesaDeSeguimiento('Confirmaré documentación oficial de acreditación con el área académica.'));
  assert.ok(promesaDeSeguimiento('Sobre acreditación por organismo reconocido, verifico con el área académica y le respondo.'));
  assert.ok(promesaDeSeguimiento('También gestiono información sobre SENESCYT Ecuador y le confirmo.'));
});

test('no confunde afirmaciones ni ofertas con promesas', () => {
  for (const t of [
    'Le confirmo que el programa dura 12 meses y es 100% en línea.',
    '¿Quiere que se lo confirme con el área académica?',
    'Le escribo por acá el detalle: son 12 cuotas de USD 150.',
    'Con gusto le cuento sobre la Maestría en Psicología.',
    'Al contado son USD 900, sin matrícula. ¿Le genero el enlace de pago?',
    'Carver opera bajo licencia del Florida Department of Education, licencia N.º 12743.',
  ]) {
    assert.equal(promesaDeSeguimiento(t), null, t);
  }
});

test('intención de pago', () => {
  for (const t of [
    'Si pago todo de contado porque valor me sale ??',
    'Quiero pagar la matrícula',
    'cómo pago?',
    'me pasa el link de pago por favor',
    'Quiero matricularme ya',
  ]) {
    assert.equal(intencionDePago(t), true, t);
  }
  for (const t of ['Cuánto cuesta la maestría?', 'Son los 2.848.000 y toca pagar algo de matrícula ?', 'quiero cancelar mi matrícula']) {
    assert.equal(intencionDePago(t), false, t);
  }
});
