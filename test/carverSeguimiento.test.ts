import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Secuencia de contacto de Carver (hallazgo 8) y su identidad (hallazgo 1). Lo que mostraron los logs
// de producción del 10 al 13 de octubre de 2026: 100+ primeros recordatorios y CERO segundos, aunque
// el segundo estaba configurado a las 10 h. Causa: la memoria del chat vence a las 6 h y el segundo
// recordatorio la encontraba vacía y se descartaba en silencio. Además, el texto del recordatorio se
// generaba como "Sofía, asesora de Postgrados de la Universidad Autónoma de Chile".
process.env.MARCA = 'carver';
process.env.NODE_ENV = 'test';
process.env.SEGUIMIENTO_SEGUNDO_HORAS = '10';

const enviados: Array<{ method: string; params: any }> = [];
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: async (method: string, params: any) => {
      enviados.push({ method, params });
      return {};
    },
    callCrm: async () => ({}),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: {} }),
    callWebhook: async () => ({}),
  },
});
const auditorias: any[] = [];
mock.module('../src/obs/audit.ts', { namedExports: { audit: async (e: any) => void auditorias.push(e) } });

let sistemaUsado = '';
let textoModelo = 'Quedo atento por si quiere retomar lo de la maestría.';
mock.module('../src/ai/client.ts', {
  namedExports: {
    anthropic: {
      messages: {
        create: async (req: any) => {
          sistemaUsado = String(req.system);
          return { content: [{ type: 'text', text: textoModelo }], usage: {} };
        },
      },
    },
    REASONER: 'claude-test-sonnet',
    CLASSIFIER: 'claude-test-haiku',
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

const zsets = new Map<string, Map<string, number>>();
const kvStore = new Map<string, string>();
const fakeRedis = {
  zadd: async (key: string, score: number, member: string) => {
    if (!zsets.has(key)) zsets.set(key, new Map());
    zsets.get(key)!.set(member, score);
    return 1;
  },
  zrem: async (key: string, member: string) => (zsets.get(key)?.delete(member) ? 1 : 0),
  zrangebyscore: async (key: string, _min: string, max: number) =>
    [...(zsets.get(key)?.entries() ?? [])].filter(([, s]) => s <= max).map(([m]) => m),
  zscore: async () => null,
  hincrby: async () => 1,
  exists: async () => 0,
  get: async () => null,
  set: async () => 'OK',
  incr: async () => 1,
};
mock.module('../src/store/kv.ts', {
  namedExports: {
    getRedisClient: () => fakeRedis,
    getJson: async (key: string) => (kvStore.has(key) ? JSON.parse(kvStore.get(key)!) : null),
    setJson: async (key: string, val: unknown) => void kvStore.set(key, JSON.stringify(val)),
    kvDel: async (key: string) => void kvStore.delete(key),
    once: async () => true,
  },
});

const seg = await import('../src/ai/seguimiento');
const { marcarTraspaso } = await import('../src/session');
const { config } = await import('../src/config');
config.seguimientoHoraInicio = 0; // el barrido no depende de la hora a la que corre la prueba
config.seguimientoHoraFin = 24;

const CONVERSACION = [
  { role: 'user', content: 'Hola, me interesa la Maestría en Inteligencia Artificial' },
  { role: 'assistant', content: [{ type: 'text', text: 'Con gusto. Es 100% en línea, con clases en vivo. ¿Le cuento el valor con la beca?' }] },
];

async function conversacionRespondida(dialogId: string) {
  kvStore.set(`mem:${dialogId}`, JSON.stringify(CONVERSACION));
  await seg.programarSeguimiento(dialogId, { deal: 1 }, '5001');
}
const vencer = (cola: string, dialogId: string) => zsets.get(cola)!.set(dialogId, Date.now() - 1000);
const envios = (dialogId: string) => enviados.filter((e) => e.method === 'imbot.message.add' && e.params.DIALOG_ID === dialogId);
const omitido = (dialogId: string) => auditorias.find((a) => a.type === 'seguimiento_omitido' && a.dialogId === dialogId)?.detail?.motivo;

test('el recordatorio de Carver habla como el asesor a cargo, no como "Sofía de Postgrados"', async () => {
  await conversacionRespondida('c-identidad');
  vencer('seguimiento:due', 'c-identidad');
  await seg.barrerSeguimientosVencidos();
  assert.equal(envios('c-identidad').length, 1);
  assert.match(sistemaUsado, /asesor a cargo de esta conversación en Carver University/);
  assert.match(sistemaUsado, /NO nombres a otras personas del equipo/);
  assert.doesNotMatch(sistemaUsado, /Sof[ií]a|Universidad Autónoma|español de Chile/);
});

test('el SEGUNDO recordatorio sale aunque la memoria del chat ya haya vencido (antes se perdía siempre)', async () => {
  await conversacionRespondida('c-segundo');
  kvStore.delete('mem:c-segundo'); // la memoria vence a las 6 h; el segundo recordatorio va a las 10
  vencer('seguimiento:segundo:due', 'c-segundo');
  await seg.barrerSegundosRecordatoriosVencidos();
  assert.equal(envios('c-segundo').length, 1, 'se generó desde la instantánea de la conversación');
  assert.ok(auditorias.some((a) => a.type === 'seguimiento' && a.dialogId === 'c-segundo' && a.detail.etapa === 2));
});

test('sin conversación de dónde generar, el descarte YA NO es silencioso: queda auditado', async () => {
  await conversacionRespondida('c-vacio');
  kvStore.delete('mem:c-vacio');
  kvStore.delete('seguimiento:snapshot:c-vacio');
  vencer('seguimiento:segundo:due', 'c-vacio');
  await seg.barrerSegundosRecordatoriosVencidos();
  assert.equal(envios('c-vacio').length, 0);
  assert.equal(omitido('c-vacio'), 'sin_conversacion');
});

test('fuera de la ventana de 24 h de WhatsApp no se envía (no llegaría)', async () => {
  await conversacionRespondida('c-ventana');
  const snap = JSON.parse(kvStore.get('seguimiento:snapshot:c-ventana')!);
  kvStore.set('seguimiento:snapshot:c-ventana', JSON.stringify({ ...snap, clienteAt: Date.now() - 25 * 3600_000 }));
  vencer('seguimiento:segundo:due', 'c-ventana');
  await seg.barrerSegundosRecordatoriosVencidos();
  assert.equal(envios('c-ventana').length, 0);
  assert.equal(omitido('c-ventana'), 'fuera_ventana_24h');
});

test('tope diario: con 2 recordatorios en 24 h, el siguiente no sale', async () => {
  kvStore.set('seguimiento:enviados:c-tope', JSON.stringify([Date.now() - 3600_000, Date.now() - 1800_000]));
  await conversacionRespondida('c-tope');
  vencer('seguimiento:due', 'c-tope');
  await seg.barrerSeguimientosVencidos();
  assert.equal(envios('c-tope').length, 0);
  assert.equal(omitido('c-tope'), 'tope_diario');
});

test('si la sesión se traspasó a una persona, el bot no le escribe al cliente', async () => {
  await conversacionRespondida('c-traspaso');
  await marcarTraspaso('c-traspaso', '5001', 'escalado');
  vencer('seguimiento:due', 'c-traspaso');
  await seg.barrerSeguimientosVencidos();
  assert.equal(envios('c-traspaso').length, 0);
  assert.equal(omitido('c-traspaso'), 'traspaso_a_persona');
});

test('se distingue enviado de respondido: la respuesta del cliente a un recordatorio queda registrada una vez', async () => {
  await conversacionRespondida('c-respondido');
  vencer('seguimiento:due', 'c-respondido');
  await seg.barrerSeguimientosVencidos();
  await seg.registrarRespuestaASeguimiento('c-respondido');
  await seg.registrarRespuestaASeguimiento('c-respondido');
  const r = auditorias.filter((a) => a.type === 'seguimiento_respondido' && a.dialogId === 'c-respondido');
  assert.equal(r.length, 1);
  assert.equal(r[0].detail.etapa, 1);
});

test('el recordatorio pasa por las mismas reglas que una respuesta: sin markdown ni enlaces sueltos', async () => {
  textoModelo = '**Hola de nuevo.** Revise el programa aquí: https://sitio-cualquiera.com/promo. Quedo atento si quiere retomarlo.';
  await conversacionRespondida('c-guardian');
  vencer('seguimiento:due', 'c-guardian');
  await seg.barrerSeguimientosVencidos();
  const msg = envios('c-guardian')[0].params.MESSAGE;
  assert.doesNotMatch(msg, /\*\*|sitio-cualquiera/);
  assert.match(msg, /Quedo atento/);
  textoModelo = 'Quedo atento por si quiere retomar lo de la maestría.';
});
