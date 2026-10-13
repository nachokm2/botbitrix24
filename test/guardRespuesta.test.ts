import { test } from 'node:test';
import assert from 'node:assert/strict';

// Guardián de la respuesta (core/guardRespuesta.ts): reglas comerciales impuestas en código, no en el
// prompt. Los textos de prueba son respuestas REALES del piloto de Carver (octubre 2026).
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

const { guardarRespuesta, preguntaPorCostosAdicionales, urlsEn } = await import('../src/core/guardRespuesta');

const ctx = (extra: Partial<Parameters<typeof guardarRespuesta>[1]> = {}) => ({
  mensajeCliente: 'Precio y contenido',
  respuestasPrevias: [],
  urlsPermitidas: ['https://carver.university/'],
  maxCaracteres: 750,
  ...extra,
});

// Respuesta real del piloto, ante "Precio y contenido": negritas y fee de titulación sin que se pidiera.
const REAL =
  'Le comparto todo junto:\n\n**Sobre el programa:** está orientado a profesionales que quieren liderar proyectos de innovación. Son 36 créditos, 100% en línea con clases en vivo.\n\n' +
  '**Precio con la Beca George Washington Carver Grant (50% aplicado):**\n\nMensualidades: 12 cuotas de USD 150 (total USD 1.800) + matrícula de USD 50 aparte.\n\n' +
  'Contado: USD 900 en un solo pago, sin matrícula. La opción más conveniente.\n\n' +
  'A eso se suma la inscripción de USD 150 (no reembolsable) y USD 125 de titulación al finalizar.\n\n¿Le gustaría profundizar en algún aspecto del programa?';

test('quita el fee de titulación cuando nadie lo preguntó (hallazgo 5)', () => {
  const r = guardarRespuesta(REAL, ctx());
  assert.doesNotMatch(r.texto, /titulaci/i);
  assert.doesNotMatch(r.texto, /USD 125/);
  assert.ok(r.cambios.includes('fee_no_solicitado'));
  // Lo demás de la cotización se conserva intacto.
  assert.match(r.texto, /12 cuotas de USD 150/);
  assert.match(r.texto, /USD 900/);
  assert.match(r.texto, /¿Le gustaría profundizar/);
});

test('ante la pregunta EXPLÍCITA por la titulación, el fee se conserva', () => {
  const texto = 'La titulación tiene un costo de USD 125, que se paga al finalizar el programa.';
  const r = guardarRespuesta(texto, ctx({ mensajeCliente: '¿Hay que pagar algo por la titulación?' }));
  assert.equal(r.texto, texto);
  assert.ok(!r.cambios.includes('fee_no_solicitado'));
});

test('preguntaPorCostosAdicionales distingue la pregunta explícita de una consulta de precio común', () => {
  for (const si of ['¿Cuánto es en total?', '¿Hay costos adicionales?', '¿Y la titulación cuánto cuesta?', '¿Qué más tengo que pagar?', '¿cuál es el costo total?']) {
    assert.equal(preguntaPorCostosAdicionales(si), true, si);
  }
  for (const no of ['¿Cuánto cuesta?', 'Precio y contenido', 'Brochure', 'Me interesa la maestría en IA']) {
    assert.equal(preguntaPorCostosAdicionales(no), false, no);
  }
});

test('convierte el markdown a texto de WhatsApp (sin ** ni títulos)', () => {
  const r = guardarRespuesta('**Sobre el programa:** es en línea.\n## Precios\nContado: USD 900.', ctx());
  assert.doesNotMatch(r.texto, /\*\*|^#/m);
  assert.match(r.texto, /Sobre el programa: es en línea\./);
  assert.ok(r.cambios.includes('markdown'));
});

test('quita un enlace que no viene de una herramienta del turno (hallazgo 2)', () => {
  const texto =
    'Aquí tiene el brochure de la Maestría en Inteligencia Artificial:\nhttps://uachile.bitrix24.es/doc/HqG2kbl5LhRQXbmZbILW\n\n¿Le gustaría que le cotice el valor?';
  const r = guardarRespuesta(texto, ctx({ mensajeCliente: 'Brochure' }));
  assert.doesNotMatch(r.texto, /bitrix24/);
  assert.doesNotMatch(r.texto, /Aquí tiene el brochure/, 'la frase que solo presentaba el enlace se va con él');
  assert.match(r.texto, /¿Le gustaría que le cotice el valor\?/);
  assert.ok(r.cambios.includes('url_no_verificada'));
});

test('conserva un enlace verificado en el turno y los oficiales de la marca', () => {
  const url = 'https://uachile.bitrix24.es/doc/HqG2kbl5LhRQXbmZbILW';
  const texto = `Le comparto el brochure:\n${url}\n\nY nuestro sitio: https://carver.university/`;
  const r = guardarRespuesta(texto, ctx({ urlsPermitidas: ['https://carver.university/', url] }));
  assert.equal(r.texto, texto);
  assert.deepEqual(r.cambios, []);
});

test('quita una frase larga repetida de un mensaje anterior (hallazgo 11)', () => {
  const previa = 'Semestral: 2 pagos de USD 630 (total USD 1.260), sin matrícula ni costos adicionales.';
  const r = guardarRespuesta(`Claro. ${previa} ¿Le acomoda esa opción?`, ctx({ mensajeCliente: '¿cuánto era?', respuestasPrevias: [previa] }));
  assert.doesNotMatch(r.texto, /2 pagos de USD 630/);
  assert.ok(r.cambios.includes('repeticion'));
});

test('nunca deja la respuesta vacía: si todo sería quitado, no se quita', () => {
  const unica = 'Además se paga la titulación de USD 125 al finalizar.';
  const r = guardarRespuesta(unica, ctx());
  assert.equal(r.texto, unica);
});

test('marca excedeLargo por encima del máximo', () => {
  assert.equal(guardarRespuesta('x'.repeat(800), ctx()).excedeLargo, true);
  assert.equal(guardarRespuesta('x'.repeat(100), ctx()).excedeLargo, false);
});

test('urlsEn encuentra los enlaces dentro de un resultado de herramienta', () => {
  const urls = urlsEn({ ok: true, url: 'https://uachile.bitrix24.es/doc/abc', nota: 'x' });
  assert.deepEqual(urls, ['https://uachile.bitrix24.es/doc/abc']);
});

test('con el CRM caído no afirma que algo quedó registrado (escenario R11 de la auditoría)', () => {
  // Respuesta real de la primera corrida DESPUÉS: el registro falló y el bot dijo "quedará registrado".
  const texto =
    '¡Hola, Carla! Confirmamos su correo: carla.nunez@ejemplo.com — quedará registrado para darle seguimiento. La Maestría en Salud Mental sí está disponible. ¿Le comparto los detalles?';
  const r = guardarRespuesta(texto, ctx({ mensajeCliente: 'Soy Carla', crmFallo: true }));
  assert.doesNotMatch(r.texto, /registrad/);
  assert.match(r.texto, /Maestría en Salud Mental sí está disponible/);
  assert.ok(r.cambios.includes('afirmacion_registro_fallido'));
  // Sin falla del CRM, la misma frase es verdadera y se deja.
  assert.match(guardarRespuesta(texto, ctx({ mensajeCliente: 'Soy Carla' })).texto, /quedará registrado/);
});

test('detecta la afirmación de registro aunque tenga palabras en medio ("Quedé con sus datos anotados")', () => {
  const texto = '¡Hola, Carla! Quedé con sus datos anotados para darle seguimiento. ¿Le cuento el programa?';
  const r = guardarRespuesta(texto, ctx({ mensajeCliente: 'Soy Carla', crmFallo: true }));
  assert.doesNotMatch(r.texto, /anotad/);
  assert.match(r.texto, /¿Le cuento el programa\?/);
});
