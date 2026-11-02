import { test } from 'node:test';
import assert from 'node:assert/strict';

// Idioma del cliente. Carver es una universidad estadounidense con alumnos en toda Latinoamérica:
// el 10% de sus leads tiene número de Estados Unidos y hay brasileños. Contestarle en español a
// quien escribe en portugués se lee como que nadie lo está atendiendo de verdad.
//
// El riesgo caro es el falso positivo: marcar portugués por error haría que el bot le conteste en
// portugués a un chileno. Por eso, ante la duda, siempre español.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

const { detectarIdioma, bloqueIdioma } = await import('../src/ai/idioma');

test('reconoce portugués en mensajes reales', () => {
  for (const t of [
    'Bom dia, gostaria de saber quanto custa o mestrado',
    'Olá, você pode me enviar informações do curso?',
    'Não entendi, qual é o preço da graduação?',
  ]) {
    assert.equal(detectarIdioma(t), 'pt', `no detectó portugués: ${t}`);
  }
});

test('reconoce inglés en mensajes reales', () => {
  for (const t of [
    'Hello, I would like information about the master program',
    'Hi, how much is the bachelor degree and can you send me the details?',
  ]) {
    assert.equal(detectarIdioma(t), 'en', `no detectó inglés: ${t}`);
  }
});

test('el español se queda en español', () => {
  for (const t of [
    'Hola, quiero información de la maestría en psicología',
    'Buenas tardes, cuánto cuesta el programa y cómo son los pagos',
    'No me interesa ese programa, prefiero la licenciatura',
    'Sí, me gustaría saber los requisitos de postulación',
  ]) {
    assert.equal(detectarIdioma(t), 'es', `falso positivo con: ${t}`);
  }
});

test('palabras que se ven portuguesas pero también son español no cambian el idioma (Mónica, 02-11)', () => {
  // Caso real: "como funciona" y "valores" sumaban dos marcas de portugués y el bot le contestó en
  // portugués a una clienta de Chile.
  for (const t of [
    'Si todo eso porfavor\nCómo funciona , cuando comienza y los valores',
    'Cómo funciona , cuando comienza y los valores',
    'Quería saber los valores del curso',
    'Me interesa el máster en IA, quería saber cómo funciona',
  ]) {
    assert.equal(detectarIdioma(t), 'es', `falso positivo con: ${t}`);
  }
  // Y el portugués de verdad se sigue reconociendo con esas mismas palabras.
  assert.equal(detectarIdioma('Eu quero saber como funciona o mestrado e os valores'), 'pt');
  assert.equal(detectarIdioma('Hi, my question is about the master and the price'), 'en');
});

test('un mensaje corto no alcanza para cambiar de idioma', () => {
  // "ok", "si", "no" aparecen en varios idiomas; decidir con eso sería peor que no decidir.
  for (const t of ['ok', 'si', 'no', 'hola', 'gracias', '']) {
    assert.equal(detectarIdioma(t), 'es');
  }
});

test('una sola palabra sospechosa no basta', () => {
  // "não" sola podría ser un error de tipeo o una cita; hacen falta dos señales.
  assert.equal(detectarIdioma('nao quiero eso gracias'), 'es');
});

test('la instrucción solo aparece cuando hace falta', () => {
  assert.equal(bloqueIdioma('es'), '');
  const pt = bloqueIdioma('pt');
  assert.match(pt, /portugués/);
  assert.match(pt, /nombres[\s\S]*sin traducirlos/, 'los nombres de los programas no se traducen');
  assert.match(bloqueIdioma('en'), /inglés/);
});
