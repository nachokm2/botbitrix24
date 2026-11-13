import { test } from 'node:test';
import assert from 'node:assert/strict';

// Lo que salió de leer 253 conversaciones de Carver, del 09 al 13-11-2026: bajas que no se respetaron,
// recordatorios que inventaban (una «beca del 90 %», «le tengo la respuesta», la beca según el país, un
// inicio en febrero) y respuestas que daban el título «con apostilla» o «en formato físico».
process.env.MARCA = 'carver';
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

const { pideNoMolestar, prometioNoEscribir } = await import('../src/crm/exclusion');
const { esRechazo, esSoloCortesia, motivoPorLoConversado, problemasDelRecordatorio, datosQueNoEstan } = await import('../src/ai/seguimiento');
const { guardarRespuesta, CORRECCION_APOSTILLA, CORRECCION_FISICO } = await import('../src/core/guardRespuesta');

const ctx = { mensajeCliente: '¿El título sirve en Costa Rica?', respuestasPrevias: [], urlsPermitidas: [], maxCaracteres: 2000 };

test('las bajas que se escaparon ahora se reconocen', () => {
  for (const t of [
    'Detener promociones Detener promociones', // botón de baja de la plantilla (chat 1596719)
    'Amigo porfa deje de molestar Esta cuando molestan', // chat 1593997
    'Porfa ya es mucho la molestia Si sigue lo voy a denunciar',
    'deja de escribirme',
    'Cancelar mensajes',
  ]) {
    assert.equal(pideNoMolestar(t), true, t);
    assert.equal(esRechazo(t), true, t);
  }
  // Lo de siempre sigue sin ser una baja.
  for (const t of ['no gracias, prefiero la licenciatura', 'no me interesa ese programa', '¿Cómo detengo el pago automático?', 'No deja de sorprenderme el programa']) {
    assert.equal(pideNoMolestar(t), false, t);
  }
});

test('el bot que promete no escribir más queda obligado', () => {
  for (const t of [
    'Entendido, Juan, no le escribo más por acá. Si en algún momento quiere retomar, con gusto le ayudo.',
    'Disculpe. No le escribimos más.',
    'Entendido. No le molesto más.',
    'No escribo más, Juan. Respeto su solicitud.',
    'Respetaré su solicitud. No volveré a contactarlo a menos que usted lo desee.',
    'Lo registro para que no le lleguen más mensajes promocionales.',
  ]) {
    assert.equal(prometioNoEscribir(t), true, t);
  }
  for (const t of [
    'Quedo por acá cuando guste escribirme.',
    'Le escribo mañana con la respuesta.',
    'No le escribo por WhatsApp porque el formulario llega por correo.',
    'Si no le llega el correo, me avisa y lo reenvío.',
  ]) {
    assert.equal(prometioNoEscribir(t), false, t);
  }
});

test('un «gracias» después del no, no reactiva los recordatorios', () => {
  // Chat 1595779: «no estoy interesado» y luego «Gracias»; salieron cinco recordatorios.
  const conv = [
    'Bot: Hola, le cuento de la Maestría en Psicología.',
    'Cliente: Hola por los momentos no estoy interesado muchas gracias',
    'Bot: Gracias por avisarme. Quedo pendiente por acá.',
    'Cliente: Gracias',
    'Bot: Con mucho gusto. Aquí estaré cuando quiera.',
  ].join('\n');
  assert.equal(motivoPorLoConversado(conv, true), 'rechazo');
  // Chat 1595887: audios con «No, no, no, muchas gracias» y «Ok, igualmente».
  const conv2 = [
    'Bot: ¿Le interesa el MBA?',
    'Cliente: [URL=https://x/a.oga]Open[/URL] No, no, no, muchas gracias, en cualquier momento le escribo.',
    'Bot: Perfecto, quedo por acá.',
    'Cliente: [URL=https://x/b.oga]Open[/URL] Ok, igualmente, gracias, gracias.',
    'Bot: ¡Gracias a usted!',
  ].join('\n');
  assert.equal(motivoPorLoConversado(conv2, true), 'rechazo');
  // Si después del no vuelve a preguntar, se le sigue escribiendo.
  const conv3 = [
    'Cliente: no me interesa por ahora',
    'Bot: Entiendo.',
    'Cliente: Bueno, ¿y cuánto cuesta el MBA?',
    'Bot: Con la beca del 50 %, ...',
  ].join('\n');
  assert.equal(motivoPorLoConversado(conv3, true), null);
  assert.equal(esSoloCortesia('Ok, igualmente, gracias, gracias.'), true);
  assert.equal(esSoloCortesia('Adiós, bendiciones 🙏'), true);
  assert.equal(esSoloCortesia('Sí'), false);
  assert.equal(esRechazo('No, gracias, prefiero la licenciatura'), false);
});

test('si el bot ya prometió no escribir, ningún recordatorio sale (también en Postgrados)', () => {
  const conv = [
    'Cliente: Porfa ya es mucho la molestia',
    'Bot: Tiene razón, lo siento. No le escribo más.',
    'Cliente: Aburrete',
    'Bot: Entendido.',
  ].join('\n');
  assert.equal(motivoPorLoConversado(conv, true), 'baja_prometida');
  assert.equal(motivoPorLoConversado(conv, false), 'baja_prometida');
  // Una promesa vieja, seguida de una conversación nueva, ya no cuenta.
  const vieja = ['Bot: No le escribo más.', 'Cliente: Hola de nuevo, ¿cuánto cuesta?', 'Bot: Con gusto.', 'Cliente: ¿Y el MBA?', 'Bot: Claro.', 'Cliente: Gracias', 'Bot: A usted.'].join('\n');
  assert.equal(motivoPorLoConversado(vieja, true), null);
});

test('los recordatorios inventados de esta semana no pasan', () => {
  for (const t of [
    '¿Ya envió la cédula y el diploma que le pedimos para su beca del 90%?', // chat 1065861
    'Le tengo la respuesta sobre dónde consultar el programa.', // chat 1587709
    '¿Cuál es su país de residencia para confirmar si puede acceder a la beca?', // chat 1599155
    '¿Cuál es su país de residencia? Así le confirmo los requisitos específicos de postulación.',
    'El próximo ciclo inicia pronto y los cupos con beca son limitados.',
    // Lo mismo dicho de tú: Carver tutea desde el 13-11-2026.
    'Te tengo la respuesta sobre dónde consultar el programa.',
    '¿Cuál es tu país de residencia? Así te confirmo los requisitos específicos de postulación.',
    '¿Ya enviaste la cédula para tu beca del 90%?',
  ]) {
    assert.ok(problemasDelRecordatorio(t).length > 0, t);
  }
  for (const t of [
    'El programa es 100% en línea, con clases en vivo.',
    'Te recuerdo que la beca es del 50 %.',
    '¿Te cuento cuándo cierra la postulación?',
  ]) {
    assert.deepEqual(problemasDelRecordatorio(t), [], t);
  }
});

test('un mes que nadie nombró no sale en el recordatorio', () => {
  const conv = 'Cliente: Hola\nBot: El próximo ciclo empieza el 23 de noviembre y luego el 11 de enero.';
  assert.ok(datosQueNoEstan('¿Le cuento cómo podría comenzar en febrero?', conv).length > 0); // chat 1045696
  assert.deepEqual(datosQueNoEstan('¿Le sirve empezar en enero?', conv), []);
});

test('el título no se da como apostillado ni en papel', () => {
  const r = guardarRespuesta(
    'Carver emite títulos oficiales estadounidenses con apostilla de La Haya. En Costa Rica el trámite lo hace CONARE.',
    ctx,
  );
  assert.ok(r.cambios.includes('titulo_apostilla_o_fisico'));
  assert.match(r.texto, new RegExp(CORRECCION_APOSTILLA.slice(0, 30)));
  assert.match(r.texto, /CONARE/); // lo demás queda igual
  assert.doesNotMatch(r.texto, /con apostilla de La Haya/);

  const f = guardarRespuesta('El título se obtiene en formato físico; la apostilla de La Haya es trámite aparte. ¿Cuál es el programa?', ctx);
  assert.ok(f.cambios.includes('titulo_apostilla_o_fisico'));
  assert.match(f.texto, new RegExp(CORRECCION_FISICO.slice(0, 30)));
  assert.match(f.texto, /¿Cuál es el programa\?/);

  const e = guardarRespuesta('Carver entrega el título con apostilla y documentación necesaria para el trámite.', ctx);
  assert.ok(e.cambios.includes('titulo_apostilla_o_fisico'));
});

test('lo que ya estaba bien dicho no se toca', () => {
  for (const t of [
    'Carver University otorga títulos oficiales y gestiona la apostilla, lo que facilita su reconocimiento en Chile.',
    'Los títulos no vienen apostillados: la apostilla es un trámite aparte.',
    'Si necesita los documentos físicos apostillados, la universidad le apoya con el proceso.',
    'El título y el transcript se entregan en digital, y se pueden pedir en físico.',
  ]) {
    const r = guardarRespuesta(t, ctx);
    assert.ok(!r.cambios.includes('titulo_apostilla_o_fisico'), t);
    assert.equal(r.texto, t);
  }
});
