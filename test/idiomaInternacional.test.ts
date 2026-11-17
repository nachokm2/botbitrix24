import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// 17-11-2026 (chat1608903): una persona escribió en hindi, con la imagen del anuncio, en un chat que ya
// tenía la bienvenida y plantillas en español de Bitrix. El bot le contestó «Hola Ashu, bienvenido/a…».
// Tres arreglos: el historial previo va con instrucciones en inglés, el idioma se detecta aunque haya una
// imagen, y una respuesta en español a quien no escribe en español se pasa a su idioma antes de enviarla.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.MARCA = 'carver';

const pedidos: any[] = [];
let traduccion = '';
mock.module('../src/ai/client.ts', {
  namedExports: {
    anthropic: {
      messages: {
        create: async (req: any) => {
          pedidos.push(req);
          return { content: [{ type: 'text', text: traduccion }], usage: {} };
        },
      },
    },
    REASONER: 'modelo-de-prueba',
    CLASSIFIER: 'clasificador-de-prueba',
  },
});

const { escritoEnEspanol: pareceEspanol } = await import('../src/ai/idioma');
const { aplicarGuardian, EDITOR_IDIOMA_INTERNACIONAL, INSTRUCCION_HISTORIAL_INTERNACIONAL } = await import('../src/ai/agentLoop');

const RESPUESTA_REAL =
  'Hola Ashu, bienvenido/a. Applied AI & Automation (AI@Work) de Carver University es 100% online, 16 semanas, clases en vivo en inglés. ' +
  'Aprendes a aplicar IA a tu trabajo, terminas con 5 soluciones reales y recibes certificado. Precio con beca 50%: USD 400 pago único o 4 cuotas de USD 200 (aplican impuestos). ¿En qué trabajas y usas programación?';
const MENSAJE_HINDI = 'नमस्ते! क्या मुझे इस बारे में और पता चल सकता है?\n\nhttps://fb.me/kjZARnoyY\n\nPut AI to Work';

test('reconoce una respuesta en español, y no confunde inglés ni hinglish', () => {
  assert.equal(pareceEspanol(RESPUESTA_REAL), true);
  assert.equal(pareceEspanol('Hi Ashu! Applied AI & Automation is a 16-week live-online course. What kind of work do you do?'), false);
  assert.equal(pareceEspanol('Ashraf, samajh gaya — koi baat nahi. Yeh programme 100% English mein hai, aur classes live hoti hain.'), false);
  assert.equal(pareceEspanol('नमस्ते! यह 16 हफ्ते का ऑनलाइन कोर्स है।'), false);
  assert.equal(pareceEspanol('Tu kya karta hai bhai?'), false);
});

test('una respuesta en español a quien escribió en hindi se pasa a su idioma, con cifras intactas', async () => {
  pedidos.length = 0;
  traduccion = 'Namaste Ashu! Applied AI & Automation (AI@Work) Carver University ka 16-week online course hai. Price: USD 400 ek baar ya 4 instalments of USD 200. Aap kya kaam karte hain?';
  const final = await aplicarGuardian(RESPUESTA_REAL, { mensajeCliente: MENSAJE_HINDI, history: [], mensajesDelTurno: [], internacional: true, simulacion: true });
  assert.equal(final, traduccion);
  const pedido = pedidos.find((p) => p.system === EDITOR_IDIOMA_INTERNACIONAL);
  assert.ok(pedido, 'se pidió la traducción');
  assert.match(pedido.messages[0].content, /नमस्ते/);
});

test('si la traducción pierde un monto, sale como estaba (no se inventa)', async () => {
  traduccion = 'Namaste Ashu! It is a 16-week online course. Price: USD 40.';
  const final = await aplicarGuardian(RESPUESTA_REAL, { mensajeCliente: MENSAJE_HINDI, history: [], mensajesDelTurno: [], internacional: true, simulacion: true });
  assert.match(final, /Hola Ashu/);
});

test('si la persona escribe en español, se le contesta en español', async () => {
  pedidos.length = 0;
  const final = await aplicarGuardian(RESPUESTA_REAL, {
    mensajeCliente: 'Hola, quiero saber cuánto cuesta el curso y cuándo empieza, por favor',
    history: [],
    mensajesDelTurno: [],
    internacional: true,
    simulacion: true,
  });
  assert.equal(pedidos.filter((p) => p.system === EDITOR_IDIOMA_INTERNACIONAL).length, 0);
  assert.match(final, /Hola Ashu/);
});

test('el historial previo del modo internacional dice que no se conteste en español', () => {
  assert.match(INSTRUCCION_HISTORIAL_INTERNACIONAL, /never reply in Spanish because of them/);
});
