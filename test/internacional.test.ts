import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Modo internacional (core/internacional.ts): un programa que se ofrece fuera de Latinoamérica por el
// mismo número, sin asesores. En la prueba del 05-11-2026, con el programa cargado como uno más, el bot
// contestó en español y le ofreció la maestría (con beca y calendario de Latinoamérica) a quien venía
// por el anuncio. El programa de estas pruebas es inventado: el real no se publica en este repositorio.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.MARCA = 'carver';
process.env.INTERNACIONAL_PREFIJOS = '+91';
process.env.INTERNACIONAL_PALABRAS = 'Demo@Pro';
process.env.INTERNACIONAL_AVISAR_A = '62741,4173';

const notificaciones: { USER_ID: number; MESSAGE: string }[] = [];
const llamadas: string[] = [];
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: async (method: string, params: any) => {
      llamadas.push(method);
      if (method === 'im.notify.personal.add') notificaciones.push(params);
      return {};
    },
    callCrm: async () => ({}),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: [], total: 0, next: null }),
    callWebhook: async () => ({}),
  },
});

const kv = new Map<string, unknown>();
mock.module('../src/store/kv.ts', {
  namedExports: {
    getRedisClient: () => null,
    redisHealth: () => 'off',
    once: async (k: string) => {
      if (kv.has(k)) return false;
      kv.set(k, true);
      return true;
    },
    kvDel: async (k: string) => void kv.delete(k),
    kvGet: async (k: string) => (kv.has(k) ? JSON.stringify(kv.get(k)) : null),
    kvSet: async (k: string, v: string) => void kv.set(k, v),
    getJson: async (k: string) => (kv.get(k) as any) ?? null,
    getJsonOrThrow: async (k: string) => (kv.get(k) as any) ?? null,
    setJson: async (k: string, v: unknown) => void kv.set(k, v),
  },
});
const auditorias: any[] = [];
mock.module('../src/obs/audit.ts', { namedExports: { audit: async (e: any) => void auditorias.push(e) } });

const {
  fichaInternacional,
  fichaSiEsInternacional,
  esTelefonoInternacional,
  mencionaPalabraInternacional,
  promptInternacional,
  perfilInternacional,
  urlsDeLaFicha,
} = await import('../src/core/internacional');
const { _fijarPublicadaParaPruebas } = await import('../src/core/ajustes');
const { validarConocimiento } = await import('../src/core/ajustesConocimiento');
const { consultarInformacionInstitucional } = await import('../src/core/conocimientoComercial');
const { detectarIdioma, bloqueIdioma } = await import('../src/ai/idioma');
const { herramientasDelPerfil, pareceEspanol } = await import('../src/ai/agentLoop');
const { executeTool } = await import('../src/ai/toolRunner');
const { WHATSAPP_PROFILE } = await import('../src/core/channel');
const { transcripcionesConFuentes } = await import('../src/store/db');

const FILAS = [
  { apartado: 'Programme', contenido: 'Demo@Pro Certificate: 12 weeks, taught in English.' },
  { apartado: 'Price', contenido: 'USD 300 in full, or 3 instalments of USD 110. Applicable taxes may apply.' },
  { apartado: 'Pay in full', contenido: 'Secure payment link for USD 300.', enlace: 'https://pagos.example.com/demo-contado' },
];

function publicar(tema: Record<string, unknown> | null) {
  if (!tema) return _fijarPublicadaParaPruebas('conocimiento', null);
  const v = validarConocimiento({ temas: { programa_internacional: tema } });
  assert.ok(v.ok, JSON.stringify(!v.ok && v.errores));
  _fijarPublicadaParaPruebas('conocimiento', v.valor);
}
const activo = { activo: true, fuente: 'Documento del programa (prueba)', responsable: 'prueba', vigenteHasta: '', entradas: FILAS };

test('la ficha solo rige activa, con fuente y sin vencer; vacía, el modo no existe', () => {
  publicar(null);
  assert.equal(fichaInternacional(), null, 'en el repositorio el tema viene vacío y pendiente');
  publicar(activo);
  assert.deepEqual(
    fichaInternacional()?.map((f) => f.apartado),
    ['Programme', 'Price', 'Pay in full'],
  );
  publicar({ ...activo, activo: false });
  assert.equal(fichaInternacional(), null);
  publicar({ ...activo, vigenteHasta: '2026-01-31' });
  assert.equal(fichaInternacional(new Date('2026-11-05T12:00:00Z')), null, 'vencida');
});

test('el panel valida las filas como cualquier tema: un enlace que no es https se rechaza', () => {
  const v = validarConocimiento({ temas: { programa_internacional: { ...activo, entradas: [{ apartado: 'Pago', contenido: 'x', enlace: 'http://pagos.example.com' }] } } });
  assert.equal(v.ok, false);
  const sinFuente = validarConocimiento({ temas: { programa_internacional: { ...activo, fuente: '' } } });
  assert.equal(sinFuente.ok, false, 'activo sin fuente: el bot no lo usaría');
});

test('el bot de Latinoamérica no puede leer la ficha: su herramienta no conoce el tema', () => {
  publicar(activo);
  const r = consultarInformacionInstitucional('programa_internacional');
  assert.equal(r.ok, false);
});

test('entra quien escribe desde +91 con el número completo, no un celular chileno sin el 56', () => {
  assert.equal(esTelefonoInternacional('919876543210'), true);
  assert.equal(esTelefonoInternacional('+91 98765 43210'), true);
  assert.equal(esTelefonoInternacional('912345678'), false, 'celular chileno sin código de país');
  assert.equal(esTelefonoInternacional('56912345678'), false);
  assert.equal(esTelefonoInternacional(null), false);
});

test('entra quien menciona la palabra del anuncio, escrita como sea', () => {
  assert.equal(mencionaPalabraInternacional('Hi! I want to know more about Demo@Pro'), true);
  assert.equal(mencionaPalabraInternacional('info sobre demo @ pro por favor'), true);
  assert.equal(mencionaPalabraInternacional('Demo Pro?'), true);
  assert.equal(mencionaPalabraInternacional('Hola, quiero información de la maestría'), false);
});

test('la conversación queda en el modo aunque después no lo mencione; sin ficha, nadie entra', async () => {
  publicar(activo);
  const sinTelefono = async () => null;
  assert.ok(await fichaSiEsInternacional({ dialogId: 'chat1', telefono: sinTelefono, textos: ['Hello! I saw Demo@Pro'] }));
  assert.ok(await fichaSiEsInternacional({ dialogId: 'chat1', telefono: sinTelefono, textos: ['how much?'] }), 'recordada');
  assert.ok(await fichaSiEsInternacional({ dialogId: 'chat2', telefono: async () => '919876543210', textos: ['hi'] }));
  assert.equal(await fichaSiEsInternacional({ dialogId: 'chat3', telefono: async () => '56912345678', textos: ['Hola'] }), null);

  publicar({ ...activo, activo: false });
  assert.equal(await fichaSiEsInternacional({ dialogId: 'chat1', telefono: sinTelefono, textos: ['how much?'] }), null);
});

test('el prompt va en inglés, con la ficha y sus enlaces, y pide responder en el idioma de la persona', () => {
  const p = promptInternacional(FILAS);
  assert.match(p, /LANGUAGE \(strict\)/);
  assert.match(p, /Devanagari/);
  assert.match(p, /- Price: USD 300 in full/);
  assert.match(p, /Link: https:\/\/pagos\.example\.com\/demo-contado/);
  assert.doesNotMatch(p, /beca|matr[ií]cula|SIEMPRE en español/i, 'nada del prompt de Latinoamérica');
  assert.deepEqual(urlsDeLaFicha(FILAS), ['https://pagos.example.com/demo-contado']);
});

test('el prompt explica los audios transcritos y no repite saludos religiosos (14-11-2026)', () => {
  const p = promptInternacional(FILAS);
  // La transcripción escribe el hindi en devanagari aunque la persona escriba en letras latinas.
  assert.match(p, /\[voice message\]/);
  assert.match(p, /choose the script by how they TYPE/);
  assert.match(p, /reply in Hinglish with Latin letters/);
  // El bot contestó «Jai Shri Ram! 🙏» a una imagen de saludo, y describió una selfie.
  assert.match(p, /religious or political greeting/);
  assert.match(p, /without repeating it/);
  assert.match(p, /selfies/);
});

test('el perfil no trae catálogo, precios ni conocimiento de Latinoamérica, y derivar se describe distinto', () => {
  const perfil = perfilInternacional(WHATSAPP_PROFILE, FILAS);
  assert.deepEqual(perfil.toolNames, ['registrar_interes_crm', 'escalar_a_humano']);
  assert.equal(perfil.respondeEnIdiomaDelCliente, true);
  const tools = herramientasDelPerfil(perfil);
  assert.deepEqual(tools.map((t) => t.name).sort(), ['escalar_a_humano', 'registrar_interes_crm']);
  assert.match(tools.find((t) => t.name === 'escalar_a_humano')!.description, /Never use it because they want to enrol/);
  // El perfil de siempre conserva su descripción.
  assert.match(herramientasDelPerfil(WHATSAPP_PROFILE).find((t) => t.name === 'escalar_a_humano')!.description, /asesor humano/);
});

test('derivar en el modo internacional avisa al equipo y NO entrega el chat ni marca traspaso', async () => {
  notificaciones.length = 0;
  llamadas.length = 0;
  const ctx: any = {
    profile: perfilInternacional(WHATSAPP_PROFILE, FILAS),
    auth: { domain: 'test.bitrix24.com', access_token: 't' },
    conversationId: 'chat1592000',
    chatId: 1592000,
    crmEntities: { deal: 5 },
    internacional: true,
  };
  const r = await executeTool('escalar_a_humano', { motivo: 'Pago informado: primera cuota de USD 110' }, ctx);
  assert.equal(r.ok, true);
  assert.equal(ctx.transferirAOperador, undefined, 'no hay asesor a quien entregarlo');
  assert.deepEqual(notificaciones.map((n) => n.USER_ID), [62741, 4173]);
  assert.match(notificaciones[0].MESSAGE, /un alumno dice que pagó/);
  assert.match(notificaciones[0].MESSAGE, /IM_DIALOG=chat1592000/);
  assert.ok(!llamadas.some((m) => m.startsWith('imopenlines.')), 'ninguna llamada de traspaso');
  assert.ok(!kv.has('traspaso:chat1592000'));
});

test('idioma: devanagari, hinglish y el texto que Meta deja escrito en los anuncios', () => {
  assert.equal(detectarIdioma('नमस्ते, मुझे इस कोर्स के बारे में जानकारी चाहिए'), 'hi');
  assert.equal(detectarIdioma('Hi, maine aapka ad dekha. Fees kitni hai?'), 'hi');
  assert.equal(detectarIdioma('Main fresher hoon, iske baad job milegi kya?'), 'hi');
  assert.equal(detectarIdioma('Hello! Can I get more info on this?'), 'en');
  assert.equal(detectarIdioma('Hola, quiero saber el precio de la maestría'), 'es');
  assert.equal(detectarIdioma('Cómo funciona, cuándo comienza y los valores'), 'es');
  assert.match(bloqueIdioma('hi'), /devanagari.*hinglish/s);
});

test('la corrección de "usted" solo corre sobre respuestas en español', () => {
  assert.equal(pareceEspanol('¡Hola! Con gusto te cuento del programa.'), true);
  assert.equal(pareceEspanol('Haan, aap join kar sakte hain. Tu bhi aa sakta hai.'), false);
  assert.equal(pareceEspanol('Yes, EMI is available. Applicable taxes may apply.'), false);
});

test('el auditor diario sabe que los precios del modo internacional salen de su ficha', () => {
  const [c] = transcripcionesConFuentes([
    { dialog_id: 'chat9', ts: '2026-11-05T15:00:00Z', type: 'turn', crm_entity: null, detail: { message: 'price?', reply: 'USD 300', internacional: true } },
  ]);
  assert.match(c.texto, /ficha del programa internacional/);
});
