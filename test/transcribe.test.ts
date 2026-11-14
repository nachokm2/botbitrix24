import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Transcripción de audios (ai/transcribe.ts). El 14-11-2026 los 5 audios de India salieron vacíos porque
// Deepgram estaba fijo en español; en el modo internacional va nova-3 multilingüe (inglés, hindi y hinglish).
process.env.NODE_ENV = 'test';
process.env.DEEPGRAM_API_KEY = 'clave-de-prueba';
delete process.env.DEEPGRAM_MODEL;
delete process.env.DEEPGRAM_MODEL_MULTILINGUE;

const { parametrosDeepgram, transcribeAudio } = await import('../src/ai/transcribe');

const fetchOriginal = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = fetchOriginal;
});

function fetchFalso(transcript: string, pedidas: string[]) {
  globalThis.fetch = (async (url: string) => {
    pedidas.push(String(url));
    return new Response(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript, languages: ['hi'] }] }] } }), { status: 200 });
  }) as any;
}

test('sin modo internacional, los parámetros de siempre: español con nova-2', () => {
  const qs = parametrosDeepgram();
  assert.equal(qs.toString(), 'model=nova-2&language=es&smart_format=true&punctuate=true');
  assert.equal(parametrosDeepgram({ multilingue: false }).toString(), qs.toString());
});

test('en el modo internacional: nova-3 multilingüe, con pistas hacia hindi e inglés', () => {
  const qs = parametrosDeepgram({ multilingue: true });
  assert.equal(qs.get('model'), 'nova-3');
  assert.equal(qs.get('language'), 'multi');
  assert.deepEqual(qs.getAll('language_hint'), ['hi', 'en']);
  assert.equal(qs.get('smart_format'), 'true');
});

test('transcribeAudio pide a Deepgram con los parámetros del modo y devuelve el texto', async () => {
  const pedidas: string[] = [];
  fetchFalso('किसका number है?', pedidas);
  assert.equal(await transcribeAudio(Buffer.from('x').toString('base64'), 'audio/ogg', { multilingue: true }), 'किसका number है?');
  assert.match(pedidas[0], /language=multi/);
  assert.match(pedidas[0], /model=nova-3/);

  fetchFalso('hola, quería saber el precio', pedidas);
  assert.equal(await transcribeAudio(Buffer.from('x').toString('base64'), 'audio/ogg'), 'hola, quería saber el precio');
  assert.match(pedidas[1], /language=es/);
});

test('un audio sin voz devuelve null, y el bot pide que escriba', async () => {
  fetchFalso('   ', []);
  assert.equal(await transcribeAudio(Buffer.from('x').toString('base64'), 'audio/ogg', { multilingue: true }), null);
});
