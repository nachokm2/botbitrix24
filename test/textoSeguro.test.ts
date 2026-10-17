import { test } from 'node:test';
import assert from 'node:assert/strict';

// El 16-10-2026 el bot dejó de responder en chat1483881 con un 400 de la API:
//   "The request body is not valid JSON: unexpected end of hex escape"
// La causa no estaba en el mensaje del cliente sino en el historial previo: un envío masivo de 645
// caracteres traía 🇺🇸 en la posición 300, justo el largo al que se recorta cada mensaje anterior.
// `slice` cortó el emoji por la mitad, `JSON.stringify` escribió la mitad huérfana como una fuga de
// escape, y la API rechazó el cuerpo ENTERO. Y no fue un turno perdido: el historial previo solo se
// lee con Redis vacío y la rama de error no escribe en Redis, así que el chat quedó condenado a
// repetir el mismo fallo en cada mensaje siguiente.
process.env.MARCA = 'carver';
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

const { recortar, repararTexto, repararEnSitio } = await import('../src/core/textoSeguro');

/** Lo que de verdad rompe: media pareja sin su otra mitad. */
const tieneMitadSuelta = (s: string) =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

/** La secuencia literal de 6 caracteres: barra, u, d, 8, 3, c. Armada a mano para que ningún escape
 *  de este archivo se confunda con lo que se está midiendo. */
const FUGA = String.fromCharCode(92) + 'ud83c';

// El texto que cayó, reconstruido para que el corte quede en el mismo lugar: la bandera arranca en
// la unidad 299, así que el corte en la 300 la parte al medio. El relleno se calcula en vez de
// contarse, para que el caso no se desarme si alguien toca el texto.
const CORTE = 300;
const ANTES = ' 12 meses ';
const CAMPAÑA = 'a'.repeat(CORTE - 1 - ANTES.length) + ANTES + '🇺🇸 Título emitido en Estados Unidos';

test('EL CASO: recortar no parte el emoji donde slice sí lo partía', () => {
  assert.equal(tieneMitadSuelta(CAMPAÑA.slice(0, CORTE)), true, 'el slice de antes dejaba media pareja');
  assert.equal(tieneMitadSuelta(recortar(CAMPAÑA, CORTE)), false);
});

test('el recorte sigue sirviendo para lo que existe: acortar', () => {
  assert.equal(recortar('hola', 300), 'hola', 'lo corto pasa intacto, sin sufijo');
  assert.equal(recortar('abcdef', 3), 'abc…');
  assert.equal(recortar('abcdef', 3, ''), 'abc', 'el sufijo es opcional');
  assert.ok(recortar(CAMPAÑA, CORTE).length <= 301, 'nunca se pasa del tope más el sufijo');
});

test('cortar justo DESPUÉS de un emoji lo conserva entero', () => {
  // Si no, cada emoji costaría un símbolo de más por precaución.
  assert.equal(recortar('🇺🇸abc', 4, ''), '🇺🇸', 'las dos parejas entran completas');
});

test('una mitad suelta que llega de afuera se repara, no se propaga', () => {
  // WhatsApp, un campo del CRM o el recorte de un tercero: el origen da igual, el 400 es el mismo.
  const sucio = 'Hola ' + String.fromCharCode(0xd83c) + ' mundo';
  assert.equal(tieneMitadSuelta(sucio), true);
  assert.equal(tieneMitadSuelta(repararTexto(sucio)), false);
  assert.equal(repararTexto('Hola 🇺🇸 mundo'), 'Hola 🇺🇸 mundo', 'lo sano no se toca');
});

test('el filtro recorre el payload completo y lo deja EN SITIO', () => {
  // En sitio porque ese mismo arreglo es el que se guarda como historial: dejar la mitad suelta ahí
  // condenaría también a todos los turnos siguientes, no solo a este.
  const alta = String.fromCharCode(0xd83c);
  const baja = String.fromCharCode(0xdc00);
  const messages: any[] = [
    { role: 'user', content: 'texto plano ' + alta },
    { role: 'assistant', content: [{ type: 'text', text: 'anidado ' + baja }] },
    { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: 'de una tool ' + alta }] }] },
  ];
  repararEnSitio(messages);
  assert.equal(tieneMitadSuelta(JSON.stringify(messages)), false, 'no queda ninguna en todo el payload');
  assert.ok(messages[1].content[0].text.startsWith('anidado '), 'el resto del texto sobrevive');
});

test('el payload reparado ya no lleva fugas de escape a la red', () => {
  // JSON.parse de JavaScript ACEPTA mitades sueltas: por eso esto nunca se cayó en pruebas locales.
  // El que las rechaza es el parser del servidor, así que se mira la cadena tal como viaja.
  const roto = JSON.stringify({ t: 'x'.repeat(10) + String.fromCharCode(0xd83c) });
  assert.ok(roto.toLowerCase().includes(FUGA), 'así salía a la red: una fuga de escape sin cerrar');
  const sano = JSON.stringify({ t: repararTexto('x'.repeat(10) + String.fromCharCode(0xd83c)) });
  assert.ok(!sano.toLowerCase().includes(FUGA), 'ya no queda ninguna mitad escapada');
});
