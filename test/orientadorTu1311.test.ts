import { test } from 'node:test';
import assert from 'node:assert/strict';

// Decisiones de Carver del 13-11-2026 (documento de Ignacio): el bot tutea y la postulación va por la
// ficha de postulación del asesor. El bot sigue hablando COMO el asesor a cargo (el usuario lo decidió
// el mismo día). Lo que lee las respuestas del bot tiene que reconocer también las frases dichas de
// tú, o deja de funcionar en silencio.
process.env.MARCA = 'carver';
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

const { detectarUsted, detectarTuteo, guardarRespuesta, CORRECCION_APOSTILLA, COMPROMISO_EN_PRIMERA_PERSONA } = await import('../src/core/guardRespuesta');
const { promesaDeSeguimiento, promesaDeCorreo } = await import('../src/core/promesas');
const { marca } = await import('../src/marca');

const ctx = { mensajeCliente: '', respuestasPrevias: [], urlsPermitidas: [], maxCaracteres: Number.MAX_SAFE_INTEGER };

test('marca: Carver tutea, habla como el asesor y la postulación va por la ficha del asesor', () => {
  assert.equal(marca.trato, 'tu');
  assert.equal(marca.sePresentaComoAsesor, true);
  assert.equal(marca.presentacionSinAsesor, 'el área de orientación académica de Carver University');
  assert.equal(marca.matriculaConFormulario, true);
  assert.equal(marca.matriculaEnChat, false);
  assert.equal(marca.capturaDocumentos, false, 'el bot ya no pide la cédula en el chat');
  assert.doesNotMatch(marca.contactoCierreSinAsesor, /\b(le|su)\b/);
});

test('detectarUsted: marca el usted y deja pasar lo que se dice de un tercero', () => {
  for (const t of ['¿Le cuento el valor con la beca?', 'Disculpe la demora.', 'Con gusto, usted puede pagar en cuotas.', 'Cuénteme qué programa busca.', 'Con gusto le ayudo.']) {
    assert.ok(detectarUsted(t).length > 0, t);
  }
  for (const t of [
    '¿Te cuento el valor con la beca?',
    'Lo reviso con el área académica y te escribo por aquí.',
    'Si prefieres, puedes escribirle a admisión a su correo.',
    'Ustedes pueden estudiar desde cualquier país.',
    'El docente imparte cada sesión en vivo.',
  ]) {
    assert.deepEqual(detectarUsted(t), [], t);
  }
  // Lo de siempre sigue igual para quien trata de usted.
  assert.ok(detectarTuteo('¿Te cuento el valor?').length > 0);
});

test('las promesas de volver con algo se reconocen también de tú', () => {
  assert.ok(promesaDeSeguimiento('Lo confirmo con el área académica y te respondo por aquí.'));
  assert.ok(promesaDeSeguimiento('Te aviso apenas tenga la respuesta.'));
  assert.ok(promesaDeSeguimiento('Lo reviso y te confirmo.'));
  assert.ok(promesaDeSeguimiento('Te escribiré mañana con el detalle.'));
  assert.equal(promesaDeSeguimiento('¿Quieres que te lo confirme?'), null, 'una oferta no es una promesa');
  assert.ok(promesaDeCorreo('Te envío el detalle al correo que tenemos registrado.'));
});

test('la derivación anunciada de tú también se cambia por el compromiso en primera persona', () => {
  assert.match(COMPROMISO_EN_PRIMERA_PERSONA, /te respondo/);
  for (const t of ['Te conecto con un asesor para que te ayude.', 'Ya te he derivado al equipo de admisión.', 'Un asesor te contactará a la brevedad.']) {
    const r = guardarRespuesta(t, { ...ctx, derivacionInterna: true });
    assert.ok(r.cambios.includes('derivacion_anunciada'), t);
    assert.equal(r.texto, COMPROMISO_EN_PRIMERA_PERSONA);
  }
  // El compromiso en primera persona del propio asesor no se toca.
  const r = guardarRespuesta('Reviso tu pago y te confirmo en un máximo de 24 horas hábiles.', { ...ctx, derivacionInterna: true });
  assert.deepEqual(r.cambios, []);
});

test('las correcciones del título salen de tú y respetan lo bien dicho de tú', () => {
  assert.match(CORRECCION_APOSTILLA, /puedes gestionar/);
  assert.deepEqual(guardarRespuesta('El título se entrega con apostilla si la necesitas, y puedes pedirla aparte.', ctx).cambios, []);
  const mal = guardarRespuesta('Carver entrega el título con apostilla.', ctx);
  assert.equal(mal.texto, CORRECCION_APOSTILLA);
});

test('una frase que solo presentaba un enlace quitado no queda colgando, también de tú', () => {
  const r = guardarRespuesta('Aquí te dejo el brochure:\nhttps://no-verificado.example/x\n¿Te cuento el valor con la beca?', ctx);
  assert.equal(r.texto, '¿Te cuento el valor con la beca?');
});
