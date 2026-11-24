import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Modo internacional: mensajes ajenos a la admisión (core/fueraDeTema.ts). El 18-11-2026 alguien ofreció
// un puesto de tutor con seis mensajes en un minuto y el bot contestó siete veces lo mismo.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.MARCA = 'carver';

const kv = new Map<string, unknown>();
mock.module('../src/store/kv.ts', {
  namedExports: {
    getRedisClient: () => null,
    redisHealth: () => 'off',
    once: async () => true,
    kvDel: async (k: string) => void kv.delete(k),
    kvGet: async (k: string) => (kv.has(k) ? JSON.stringify(kv.get(k)) : null),
    kvSet: async (k: string, v: string) => void kv.set(k, v),
    getJson: async (k: string) => (kv.get(k) as any) ?? null,
    getJsonOrThrow: async (k: string) => (kv.get(k) as any) ?? null,
    setJson: async (k: string, v: unknown) => void kv.set(k, v),
  },
});

const { separarFueraDeTema, contarFueraDeTema, debeCallar, MARCA_FUERA_DE_TEMA, MAX_RESPUESTAS_FUERA_DE_TEMA } = await import(
  '../src/core/fueraDeTema'
);
const { promptInternacional } = await import('../src/core/internacional');

test('la marca se quita de donde esté y la persona nunca la lee', () => {
  assert.deepEqual(separarFueraDeTema('[OFF_TOPIC] This chat is only for admissions.'), {
    texto: 'This chat is only for admissions.',
    fuera: true,
  });
  assert.deepEqual(separarFueraDeTema('This chat is only for admissions. [off_topic]'), {
    texto: 'This chat is only for admissions.',
    fuera: true,
  });
  assert.deepEqual(separarFueraDeTema('[ OFF-TOPIC ]\n\n\nSorry, only admissions here.'), {
    texto: 'Sorry, only admissions here.',
    fuera: true,
  });
  assert.deepEqual(separarFueraDeTema('The programme is 16 weeks.'), { texto: 'The programme is 16 weeks.', fuera: false });
  assert.deepEqual(separarFueraDeTema(MARCA_FUERA_DE_TEMA), { texto: '', fuera: true }, 'solo la marca: no queda nada que enviar');
});

test('dos respuestas fuera de tema se envían y desde la tercera seguida el bot calla', async () => {
  const d = 'chat-tutor';
  const resultados: boolean[] = [];
  for (let i = 0; i < 7; i++) resultados.push(debeCallar(true, await contarFueraDeTema(d, true)));
  assert.equal(MAX_RESPUESTAS_FUERA_DE_TEMA, 2);
  assert.deepEqual(resultados, [false, false, true, true, true, true, true]);
});

test('quien vuelve a hablar del programa recupera la respuesta y la cuenta empieza de nuevo', async () => {
  const d = 'chat-vuelve';
  for (let i = 0; i < 4; i++) await contarFueraDeTema(d, true);
  assert.equal(debeCallar(false, await contarFueraDeTema(d, false)), false, 'un mensaje del programa siempre se contesta');
  assert.equal(debeCallar(true, await contarFueraDeTema(d, true)), false, 'y el siguiente fuera de tema cuenta como el primero');
});

test('un mensaje del programa nunca se calla, aunque lleve varios fuera de tema antes', () => {
  assert.equal(debeCallar(false, 9), false);
});

test('el prompt explica la marca, la elegibilidad y que no se disculpe por mensajes en español sin que se lo pidan (24-11-2026)', () => {
  const p = promptInternacional([{ apartado: 'Price', contenido: 'USD 300 in full' }]);
  // Fuera de tema.
  assert.match(p, /OFF-TOPIC \(strict\)/);
  assert.ok(p.includes(`exact marker ${MARCA_FUERA_DE_TEMA}`));
  assert.match(p, /Never use the marker for anything about the programme/);
  assert.match(p, /never repeat the same sentence/);
  // Elegibilidad antes de pedir datos: el bot le pidió el correo a un alumno de 10.º grado.
  assert.match(p, /ELIGIBILITY \(strict\)/);
  assert.match(p, /BEFORE asking for their name or email or sharing a payment link/);
  assert.match(p, /they are still at school/);
  assert.match(p, /Once the ELIGIBILITY check is passed, ask for their name/);
  // Pidió perdón por un mensaje «en español» que nunca se envió, a quien tocó «Yes, I have a question».
  assert.match(p, /Bring that up ONLY if the person says they received one/);
  assert.match(p, /never apologise for, or even mention, Spanish messages/);
  assert.match(p, /is in English on purpose/);
  // Nada del prompt de Latinoamérica.
  assert.doesNotMatch(p, /beca|matr[ií]cula|SIEMPRE en español/i);
});
