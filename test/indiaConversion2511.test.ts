import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Mejoras del piloto de India del 25-11-2026 (qué mejorar para convertir más):
//  - confianza antes de que la pidan: la licencia y el registro oficial salen en el prompt y en los enlaces permitidos;
//  - aviso al equipo cuando alguien que dejó su correo o recibió el enlace de pago no contesta el primer recordatorio;
//  - audios: si el modelo multilingüe no saca nada de un audio que dura, se prueba idioma por idioma.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.MARCA = 'carver';
process.env.INTERNACIONAL_PREFIJOS = '+91';
process.env.INTERNACIONAL_AVISAR_A = '4173';
process.env.DEEPGRAM_API_KEY = 'clave-de-prueba';
delete process.env.DEEPGRAM_IDIOMAS_RESPALDO;

type Llamada = { method: string; params: any };
const llamadas: Llamada[] = [];
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: async (method: string, params: any) => {
      llamadas.push({ method, params });
      return method === 'imbot.message.add' ? 1 : true;
    },
    callCrm: async () => ({}),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: [], total: 0, next: null }),
    callWebhook: async () => ({}),
  },
});
mock.module('../src/ai/client.ts', {
  namedExports: {
    anthropic: { messages: { create: async () => ({ content: [{ type: 'text', text: '' }], usage: {} }) } },
    REASONER: 'modelo-de-prueba',
    CLASSIFIER: 'clasificador-de-prueba',
  },
});

const I = await import('../src/core/internacional');
const C = await import('../src/core/consultasInternacionales');
const { setHistory } = await import('../src/ai/memory');
const { transcribeAudio, parametrosDeepgram } = await import('../src/ai/transcribe');

const auth = { domain: 'test.bitrix24.com', access_token: 'x' } as any;
const BOT = 800185;
const privados = () => llamadas.filter((l) => l.method === 'imbot.message.add' && String(l.params.DIALOG_ID) === '4173');

// ── Confianza: licencia y registro ────────────────────────────────────────────────────────────────
const FICHA = [
  { apartado: 'Programme', contenido: 'Applied AI & Automation, 16 weeks, live online, in English.' },
  { apartado: 'Price', contenido: 'USD 400 single payment.', enlace: 'https://payment.flywire.com/pay/payment?recipient=nzc' },
];

test('el registro oficial de la licencia viaja en el prompt y entre los enlaces permitidos', () => {
  const p = I.promptInternacional(FICHA);
  assert.ok(p.includes(I.REGISTRO_LICENCIA_URL), 'el prompt trae el enlace del registro');
  assert.match(p, /License No\. 12743/);
  assert.match(p, /TRUST \(strict\)/);
  assert.match(p, /Never say the programme, the certificate or the university is accredited or recognised, and never say that it is not/i);
  assert.deepEqual(I.urlsPermitidasInternacional(FICHA), ['https://payment.flywire.com/pay/payment?recipient=nzc', I.REGISTRO_LICENCIA_URL]);
});

test('si la ficha ya trae el registro, no se repite', () => {
  const conRegistro = [...FICHA, { apartado: 'Licence', contenido: 'Licensed, License No. 12743', enlace: I.REGISTRO_LICENCIA_URL }];
  assert.equal(I.conRegistroDeLicencia(conRegistro).length, conRegistro.length);
  assert.equal(I.urlsPermitidasInternacional(conRegistro).filter((u) => u === I.REGISTRO_LICENCIA_URL).length, 1);
  assert.equal(I.promptInternacional(conRegistro).split(`Link: ${I.REGISTRO_LICENCIA_URL}`).length - 1, 1, 'una sola fila con el registro en los datos del programa');
});

test('urlsDeLaFicha no cambia: el registro no cuenta como enlace de pago', () => {
  assert.deepEqual(I.urlsDeLaFicha(FICHA), ['https://payment.flywire.com/pay/payment?recipient=nzc']);
  assert.equal(C.traeEnlaceDePago(`Check it: ${I.REGISTRO_LICENCIA_URL}`, I.urlsPermitidasInternacional(FICHA)), false);
});

// ── Interesado parado ─────────────────────────────────────────────────────────────────────────────
test('el aviso de interesado parado dice qué hizo, cuánto lleva callado y cuánto queda de ventana', () => {
  const t = C.textoAvisoParado({ dialogId: 'chat80', motivo: 'enlace_pago', horas: 3, dealId: 77, ultimoMensaje: 'Okay' }, 'test.bitrix24.com');
  assert.match(t, /⏳ Interesado parado/);
  assert.match(t, /recibió el enlace de pago y no volvió a escribir/);
  assert.match(t, /Lleva 3 h sin responder; WhatsApp deja escribirle con texto libre unas 21 h más/);
  assert.match(t, /Su último mensaje: «Okay»/);
  assert.match(t, /el bot deja de atenderla/);
  assert.match(t, /crm\/deal\/details\/77\//);
  assert.match(C.textoAvisoParado({ dialogId: 'c', motivo: 'correo', horas: 30 }), /ya pasó la ventana de WhatsApp: solo se le puede escribir con plantilla/);
});

test('solo se avisa si dejó su correo o recibió el enlace, y una vez por conversación', async () => {
  llamadas.length = 0;
  assert.equal(await C.avisarInteresadoParado({ dialogId: 'chat81', botId: BOT }, auth), false, 'sin correo ni enlace no es un interesado');
  assert.equal(privados().length, 0);

  await C.avisarInteresado({ dialogId: 'chat82', motivo: 'correo', botId: BOT }, auth);
  await C.marcarMensajeDelCliente('chat82', Date.now() - 3 * 3600_000);
  await setHistory('chat82', [
    { role: 'user', content: 'my email is a@b.com' },
    { role: 'assistant', content: 'Thanks! Which payment option suits you?' },
  ]);
  llamadas.length = 0;
  assert.equal(await C.avisarInteresadoParado({ dialogId: 'chat82', dealId: 5, botId: BOT }, auth), true);
  const m = privados().at(-1)!.params.MESSAGE as string;
  assert.match(m, /dejó su correo y no volvió a escribir/);
  assert.match(m, /Su último mensaje: «my email is a@b\.com»/);
  assert.match(m, /Lleva 3 h sin responder/);
  assert.equal(await C.avisarInteresadoParado({ dialogId: 'chat82', botId: BOT }, auth), false, 'una vez por conversación');
});

test('el enlace de pago pesa más que el correo en el motivo', async () => {
  await C.avisarInteresado({ dialogId: 'chat83', motivo: 'correo', botId: BOT }, auth);
  await C.avisarInteresado({ dialogId: 'chat83', motivo: 'enlace_pago', botId: BOT }, auth);
  assert.equal(await C.motivoDeInteresVigente('chat83'), 'enlace_pago');
  assert.equal(await C.motivoDeInteresVigente('chat-sin-nada'), null);
});

// ── Audios ────────────────────────────────────────────────────────────────────────────────────────
const fetchOriginal = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = fetchOriginal;
});

type Respuesta = { transcript: string; confidence?: number; words?: number; duration?: number };
/** Un Deepgram falso: responde según el idioma pedido. */
function deepgramFalso(porIdioma: Record<string, Respuesta>, pedidos: string[]) {
  globalThis.fetch = (async (url: string) => {
    const idioma = new URL(String(url)).searchParams.get('language') ?? '';
    pedidos.push(idioma);
    const r = porIdioma[idioma] ?? { transcript: '' };
    return new Response(
      JSON.stringify({
        metadata: { duration: r.duration ?? porIdioma.multi?.duration ?? 6 },
        results: { channels: [{ alternatives: [{ transcript: r.transcript, confidence: r.confidence ?? 0, words: Array.from({ length: r.words ?? 0 }, () => ({})) }] }] },
      }),
      { status: 200 },
    );
  }) as any;
}
const AUDIO = Buffer.from('x').toString('base64');

test('parámetros de un solo idioma: nova-3 con ese idioma', () => {
  const qs = parametrosDeepgram({ idioma: 'te' });
  assert.equal(qs.get('model'), 'nova-3');
  assert.equal(qs.get('language'), 'te');
  assert.equal(qs.get('language_hint'), null);
});

test('audio vacío en multi y largo: se prueban los idiomas de respaldo y se elige el más seguro', async () => {
  const pedidos: string[] = [];
  deepgramFalso(
    {
      multi: { transcript: '' },
      hi: { transcript: 'garbled noise', confidence: 0.4, words: 5 },
      te: { transcript: 'నాకు కోర్సు గురించి చెప్పండి', confidence: 0.91, words: 5 },
      ta: { transcript: 'x', confidence: 0.99, words: 1 },
    },
    pedidos,
  );
  assert.equal(await transcribeAudio(AUDIO, 'audio/ogg', { multilingue: true }), 'నాకు కోర్సు గురించి చెప్పండి');
  assert.deepEqual(pedidos, ['multi', 'hi', 'te', 'ta', 'bn', 'mr']);
});

test('si ningún idioma da texto seguro, sigue siendo null y el bot pide que escriban', async () => {
  deepgramFalso({ multi: { transcript: '' }, hi: { transcript: 'ruido ruido ruido', confidence: 0.5, words: 3 } }, []);
  assert.equal(await transcribeAudio(AUDIO, 'audio/ogg', { multilingue: true }), null);
});

test('un audio corto o sin modo internacional no se reintenta', async () => {
  const pedidos: string[] = [];
  deepgramFalso({ multi: { transcript: '', duration: 1 }, es: { transcript: '', duration: 1 } }, pedidos);
  assert.equal(await transcribeAudio(AUDIO, 'audio/ogg', { multilingue: true }), null);
  assert.deepEqual(pedidos, ['multi'], 'menos de 2 s: un toque o un ruido');

  const pedidos2: string[] = [];
  deepgramFalso({ es: { transcript: '', duration: 9 } }, pedidos2);
  assert.equal(await transcribeAudio(AUDIO, 'audio/ogg'), null);
  assert.deepEqual(pedidos2, ['es'], 'en Latinoamérica no cambia nada');
});

test('si multi sí entiende, no se pide nada más', async () => {
  const pedidos: string[] = [];
  deepgramFalso({ multi: { transcript: 'what is the fee', confidence: 0.95, words: 4 } }, pedidos);
  assert.equal(await transcribeAudio(AUDIO, 'audio/ogg', { multilingue: true }), 'what is the fee');
  assert.deepEqual(pedidos, ['multi']);
});
