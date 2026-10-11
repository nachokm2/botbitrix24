import { test } from 'node:test';
import assert from 'node:assert/strict';

// Una clienta colombiana preguntó por "la beca de 2 millones de pesos colombianos" y el bot le
// respondió solo en dólares: la gente piensa en su moneda. La regla que manda acá es la misma de
// toda la capa de precios — ante la duda, NO cotizar: un equivalente con una tasa desactualizada es
// un número equivocado dicho a alguien que va a pagar.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

const { equivalencias, PAIS_POR_MONEDA } = await import('../src/core/tipoCambio');

test('tipoCambio: sin tasas todavía cargadas devuelve null, no una conversión inventada', () => {
  // La primera llamada dispara la carga en segundo plano y no espera: el turno en curso no se
  // retrasa, y hasta que haya tasas el bot habla solo en dólares.
  assert.equal(equivalencias({ totalContado: 900 }), null);
});

test('tipoCambio: cubre las monedas de los países que atiende Carver (Ecuador usa dólar)', () => {
  assert.deepEqual(Object.keys(PAIS_POR_MONEDA).sort(), ['CLP', 'COP', 'DOP', 'PEN']);
  assert.equal(PAIS_POR_MONEDA.COP, 'Colombia');
});

test('tipoCambio: con tasas reales, convierte y redondea a cifras presentables', async (t) => {
  equivalencias({ totalContado: 900 }); // dispara la carga
  await new Promise((r) => setTimeout(r, 4000));
  const eq = equivalencias({ totalContado: 900, cuotaMensual: 150 });
  if (!eq) return t.skip('sin red para traer tasas: el bot cae a dólares, que es el comportamiento seguro');

  assert.ok(eq.fecha, 'informa de cuándo son las tasas');
  assert.match(eq.nota, /APROXIMADOS/);
  assert.match(eq.nota, /el cobro se hace en DÓLARES/);

  const cop = eq.monedas.COP;
  assert.ok(cop.totalContado > 1_000_000, `USD 900 en pesos colombianos debería superar el millón, dio ${cop.totalContado}`);
  assert.equal(cop.totalContado % 1000, 0, 'se redondea al millar: nadie cotiza pesos colombianos al peso');
  assert.ok(eq.monedas.PEN.totalContado > 1000 && eq.monedas.PEN.totalContado < 10_000, 'soles en su orden de magnitud');
});
