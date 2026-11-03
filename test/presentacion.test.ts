import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// El primer mensaje del bot dice el nombre del asesor a cargo (core/presentacion.ts). Las respuestas son
// reales del 03-11-2026: ninguna de las primeras respuestas del día se presentó, aunque el prompt lo pedía.
process.env.MARCA = 'carver';
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

mock.module('../src/obs/audit.ts', { namedExports: { audit: async () => {} } });
let respuesta = '';
mock.module('../src/ai/client.ts', {
  namedExports: {
    anthropic: { messages: { create: async () => ({ content: [{ type: 'text', text: respuesta }], usage: {} }) } },
    REASONER: 'claude-test-sonnet',
    CLASSIFIER: 'claude-test-haiku',
  },
});

const { asegurarPresentacion } = await import('../src/core/presentacion');
const { runAgentTurn } = await import('../src/ai/agentLoop');
const { getHistory } = await import('../src/ai/memory');
const { WHATSAPP_PROFILE } = await import('../src/core/channel');

const ORG = 'Carver University';
const FRASE = 'y le acompaño en su proceso de admisión en Carver University.';

test('vocativo con el nombre de la persona: el saludo lo toma y la presentación va enseguida', () => {
  const r = asegurarPresentacion(
    'Yolanda, le acabo de enviar el brochure con toda la información del programa 📄\n\n¿Le cuento el valor con la beca?',
    'Valezka Hernández',
    ORG,
    'Yolanda Vega Aguilera',
  );
  assert.equal(r, `Hola, Yolanda. Soy Valezka Hernández ${FRASE}\n\nLe acabo de enviar el brochure con toda la información del programa 📄\n\n¿Le cuento el valor con la beca?`);
});

test('un saludo que es una frase propia queda primero, sin repetir el «Hola»', () => {
  const r = asegurarPresentacion(
    '¡Bienvenida, María Augusta! Le acabo de enviar el brochure de la Licenciatura en Psicología directo a su WhatsApp 📄',
    'Basthian Sepúlveda',
    ORG,
  );
  assert.equal(r, `¡Bienvenida, María Augusta! Soy Basthian Sepúlveda ${FRASE}\n\nLe acabo de enviar el brochure de la Licenciatura en Psicología directo a su WhatsApp 📄`);
  assert.equal(
    asegurarPresentacion('Hola Yolanda, le acabo de enviar el brochure.', 'Valezka Hernández', ORG),
    `Hola, Yolanda. Soy Valezka Hernández ${FRASE}\n\nLe acabo de enviar el brochure.`,
  );
});

test('sin saludo ni nombre, la presentación va antes de todo', () => {
  const r = asegurarPresentacion('Le acabo de enviar el brochure de la Maestría en Psicología directamente a su WhatsApp 📄', 'Jefferson Dávila', ORG);
  assert.equal(r, `Hola, soy Jefferson Dávila ${FRASE}\n\nLe acabo de enviar el brochure de la Maestría en Psicología directamente a su WhatsApp 📄`);
});

test('«Perfecto, …» no se toma por un nombre si no es el de la persona', () => {
  const r = asegurarPresentacion('Perfecto, le cuento el valor con la beca.', 'Sigrid Rodriguez', ORG, 'Karolina Vargas');
  assert.equal(r, `Hola, soy Sigrid Rodriguez ${FRASE}\n\nPerfecto, le cuento el valor con la beca.`);
});

test('si ya dice el nombre del asesor no se toca, con o sin tildes', () => {
  const ya = 'Hola Karolina, soy Sigrid Rodríguez. Le acabo de enviar el brochure.';
  assert.equal(asegurarPresentacion(ya, 'Sigrid Rodriguez', ORG), ya);
  assert.equal(asegurarPresentacion('Soy Valezka, le envié el brochure.', 'Valezka Hernández', ORG), 'Soy Valezka, le envié el brochure.');
  // «Ana» dentro de «Panamá» no cuenta como presentarse.
  assert.match(asegurarPresentacion('El programa se dicta en línea desde Panamá.', 'Ana Pérez', ORG), /^Hola, soy Ana Pérez/);
});

test('en el motor: solo el PRIMER mensaje del bot se presenta, y lo guardado es lo enviado', async () => {
  const ctx = {
    profile: WHATSAPP_PROFILE,
    auth: { domain: '', access_token: '' },
    conversationId: 'chat-presentacion',
    crmEntities: {},
    chatId: '1',
    identidadAsesor: { nombre: 'Basthian Sepúlveda' },
    datosConocidos: { nombre: 'Makita Arriagada' },
  } as any;
  const sinTools = async () => ({ ok: true });

  respuesta = 'Makita, la Licenciatura en Psicología dura 4 años. ¿Le cuento el valor con la beca?';
  const primero = await runAgentTurn(ctx, 'Más información', '', sinTools);
  assert.match(primero, /^Hola, Makita\. Soy Basthian Sepúlveda y le acompaño/);
  const guardado = JSON.stringify((await getHistory('chat-presentacion')).at(-1)?.content);
  assert.match(guardado, /Soy Basthian Sepúlveda/, 'el modelo recuerda que ya se presentó');

  respuesta = 'Con la beca son USD 100 al mes. ¿Le acomoda?';
  const segundo = await runAgentTurn(ctx, 'Sí', '', sinTools);
  assert.equal(segundo, 'Con la beca son USD 100 al mes. ¿Le acomoda?', 'no se vuelve a presentar');

  const sinAsesor = await runAgentTurn({ ...ctx, conversationId: 'chat-sin-asesor', identidadAsesor: null }, 'Hola', '', sinTools);
  assert.doesNotMatch(sinAsesor, /Soy|soy /, 'sin asesor a cargo no inventa un nombre');
});
