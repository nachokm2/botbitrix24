import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Revisión automática de las conversaciones del día. Todos los defectos del piloto se encontraron
// porque alguien leyó una conversación y notó algo raro; nadie lee 70 al día. Esto las lee todas y
// deja los hallazgos donde se puedan accionar. Es un lector, no un juez: no cambia nada.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

let respuestaModelo = '{"problemas":[]}';
let llamadasModelo = 0;
mock.module('../src/ai/client.ts', {
  namedExports: {
    anthropic: {
      messages: {
        create: async () => {
          llamadasModelo++;
          return { content: [{ type: 'text', text: respuestaModelo }], usage: {} };
        },
      },
    },
    REASONER: 'claude-test-sonnet',
    CLASSIFIER: 'claude-test-haiku',
  },
});

let transcripciones: any[] = [];
mock.module('../src/store/db.ts', {
  namedExports: {
    dbUltimaDerivacion: async () => null,
    dbTranscripcionesRecientes: async () => transcripciones,
    dbInsertAudit: async () => {},
    // El mock reemplaza db.ts para TODO el grafo, así que debe exportar también lo que consumen los
    // módulos que revisionDiaria.ts arrastra (seguimiento.ts → vigilanciaDerivaciones.ts).
    dbHuboOperadorDespuesDe: async () => false,
    dbDialogosConDeal: async () => [],
    dbDialogosPorTextoPrograma: async () => [],
  },
});

const auditCalls: any[] = [];
mock.module('../src/obs/audit.ts', {
  namedExports: {
    audit: async (e: any) => {
      auditCalls.push(e);
    },
  },
});

const notificaciones: any[] = [];
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: async (method: string, params: any) => {
      if (method === 'im.notify.personal.add') notificaciones.push(params);
      return {};
    },
    callCrm: async () => ({}),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: {} }),
    callWebhook: async () => ({}),
  },
});

mock.module('../src/store.ts', {
  namedExports: {
    getState: async () => ({ auth: { domain: 'test.bitrix24.com', access_token: 'tok' }, botId: 1 }),
    setAuth: async () => {},
    setBotId: async () => {},
    setAppToken: async () => {},
    requireAuth: async () => ({ domain: 'test.bitrix24.com', access_token: 'tok' }),
    EMPTY_AUTH: { domain: '', access_token: '' },
  },
});

const { revisarConversacion, revisarConversacionesRecientes } = await import('../src/ai/revisionDiaria');

const CONV = 'Cliente: hola, cuánto vale el magíster\nBot: te cuento, el arancel es...\nCliente: y cuándo empieza\nBot: ...';

function reset() {
  auditCalls.length = 0;
  notificaciones.length = 0;
  llamadasModelo = 0;
  respuestaModelo = '{"problemas":[]}';
  transcripciones = [];
}

test('una conversación sin problemas no genera hallazgos', async () => {
  reset();
  assert.deepEqual(await revisarConversacion(CONV), []);
});

test('reconoce un problema y lo normaliza', async () => {
  reset();
  respuestaModelo = '{"problemas":[{"tipo":"sin_respuesta","gravedad":"alta","detalle":"Preguntó por la fecha de inicio y no se le respondió."}]}';
  const r = await revisarConversacion(CONV);
  assert.equal(r.length, 1);
  assert.equal(r[0].tipo, 'sin_respuesta');
  assert.equal(r[0].gravedad, 'alta');
});

test('descarta un tipo que el modelo se inventó', async () => {
  reset();
  respuestaModelo = '{"problemas":[{"tipo":"el_bot_es_feo","gravedad":"alta","detalle":"x"},{"tipo":"tono","gravedad":"baja","detalle":"y"}]}';
  const r = await revisarConversacion(CONV);
  assert.equal(r.length, 1, 'solo sobrevive el tipo de la lista cerrada');
  assert.equal(r[0].tipo, 'tono');
});

test('una gravedad fuera de rango cae a media en vez de ensuciar el panel', async () => {
  reset();
  respuestaModelo = '{"problemas":[{"tipo":"tono","gravedad":"catastrófica","detalle":"x"}]}';
  assert.equal((await revisarConversacion(CONV))[0].gravedad, 'media');
});

test('un saludo suelto no se manda a revisar: no da para auditar y cuesta igual', async () => {
  reset();
  assert.deepEqual(await revisarConversacion('Cliente: hola'), []);
  assert.equal(llamadasModelo, 0);
});

test('si el modelo devuelve basura, no rompe la revisión', async () => {
  reset();
  respuestaModelo = 'lo siento, no puedo';
  assert.deepEqual(await revisarConversacion(CONV), []);
});

test('deja un hallazgo por problema, con el diálogo y la ficha', async () => {
  reset();
  respuestaModelo = '{"problemas":[{"tipo":"dato_repetido","gravedad":"media","detalle":"Pidió el nombre tres veces."}]}';
  transcripciones = [
    { dialogId: 'chat1', crmEntity: 'deal#500', turnos: 6, fin: new Date().toISOString(), texto: CONV },
    { dialogId: 'chat2', crmEntity: null, turnos: 4, fin: new Date().toISOString(), texto: CONV },
  ];
  const r = await revisarConversacionesRecientes(24, 10);

  assert.equal(r.revisadas, 2);
  assert.equal(r.conProblemas, 2);
  assert.equal(r.porTipo.dato_repetido, 2);
  assert.equal(r.graves, 0);
  assert.equal(auditCalls.length, 2);
  assert.equal(auditCalls[0].type, 'revision_hallazgo');
  assert.equal(auditCalls[0].dialogId, 'chat1');
  assert.equal(auditCalls[0].crmEntity, 'deal#500');
  assert.equal(auditCalls[1].crmEntity, undefined, 'sin ficha no inventa una');
});

test('sin conversaciones no llama al modelo ni deja nada', async () => {
  reset();
  const r = await revisarConversacionesRecientes(24, 10);
  assert.deepEqual(r, { revisadas: 0, conProblemas: 0, porTipo: {}, graves: 0 });
  assert.equal(llamadasModelo, 0);
  assert.equal(auditCalls.length, 0);
});

test('cuenta los graves aparte: son los que justifican avisarle a alguien', async () => {
  reset();
  respuestaModelo = '{"problemas":[{"tipo":"interes_perdido","gravedad":"alta","detalle":"Quería psicología y nadie le pidió los datos."}]}';
  transcripciones = [{ dialogId: 'chat1', crmEntity: null, turnos: 5, fin: new Date().toISOString(), texto: CONV }];
  const r = await revisarConversacionesRecientes(24, 10);
  assert.equal(r.graves, 1);
});
