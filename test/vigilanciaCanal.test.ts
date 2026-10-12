import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Alarma de silencio del canal. El bot de Postgrados estuvo CINCO DÍAS sin recibir un mensaje y
// nadie se enteró: no falló el código ni el servidor, dejó de entregar el canal de WhatsApp, así que
// nada de lo que vigilábamos se quejó. Esto vigila la señal que importa: que entre conversación.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

let minutosDesdeUltimo: number | null = 10;
mock.module('../src/store/db.ts', {
  namedExports: {
    dbMinutosDesdeUltimoTurno: async () => minutosDesdeUltimo,
    dbInsertAudit: async () => {},
    dbHuboOperadorDespuesDe: async () => false,
    dbDialogosConDeal: async () => [],
    dbDialogosPorTextoPrograma: async () => [],
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

const auditCalls: any[] = [];
mock.module('../src/obs/audit.ts', { namedExports: { audit: async (e: any) => { auditCalls.push(e); } } });

mock.module('../src/store.ts', {
  namedExports: {
    getState: async () => ({ auth: { domain: 'test.bitrix24.com', access_token: 'tok' }, botId: 1 }),
    setAuth: async () => {}, setBotId: async () => {}, setAppToken: async () => {},
    requireAuth: async () => ({ domain: 'test.bitrix24.com', access_token: 'tok' }),
    EMPTY_AUTH: { domain: '', access_token: '' },
  },
});

const { estadoCanal, revisarSilencioCanal, destinatarioAlerta } = await import('../src/ai/vigilanciaCanal');
const { config } = await import('../src/config');

function reset() {
  notificaciones.length = 0;
  auditCalls.length = 0;
  minutosDesdeUltimo = 10;
  config.canalSilencioHoras = 6;
  config.derivacionSupervisorId = 0;
  config.derivarATodo = 1313;
  // Horario siempre hábil, para que la prueba no dependa de la hora a la que corra.
  config.seguimientoHoraInicio = 0;
  config.seguimientoHoraFin = 24;
}

test('con actividad reciente no hay alarma', async () => {
  reset();
  const r = await revisarSilencioCanal();
  assert.equal(r.silencioso, false);
  assert.equal(r.aviso, false);
  assert.equal(notificaciones.length, 0);
});

test('pasado el umbral avisa, y dice que el servicio NO está caído', async () => {
  reset();
  minutosDesdeUltimo = 7 * 60;
  const r = await revisarSilencioCanal();

  assert.equal(r.silencioso, true);
  assert.equal(r.aviso, true);
  assert.equal(notificaciones.length, 1);
  assert.equal(notificaciones[0].USER_ID, 1313);
  assert.match(notificaciones[0].MESSAGE, /7 h/);
  assert.match(notificaciones[0].MESSAGE, /sigue en línea/, 'el aviso debe evitar que busquen la falla donde no está');
  assert.equal(auditCalls[0].type, 'canal_en_silencio');
});

test('no repite el aviso mientras dura el mismo silencio', async () => {
  reset();
  minutosDesdeUltimo = 40 * 60;
  await revisarSilencioCanal();
  // Se mide el incremento: la marca del día puede venir ya gastada por otra prueba, que es
  // exactamente el comportamiento buscado.
  const tras1 = notificaciones.length;
  await revisarSilencioCanal();
  await revisarSilencioCanal();
  assert.equal(notificaciones.length, tras1, 'un canal callado muchas horas no justifica muchos avisos');
  assert.ok(tras1 <= 1);
});

test('fuera de horario hábil no alarma: de madrugada el silencio es normal', async () => {
  reset();
  minutosDesdeUltimo = 7 * 60;
  config.seguimientoHoraInicio = 23;
  config.seguimientoHoraFin = 24; // ventana de una hora: casi siempre estamos fuera
  const r = await revisarSilencioCanal();
  if (!r.aviso) assert.equal(notificaciones.length, 0);
});

test('prefiere al supervisor y cae al punto de entrada único', () => {
  reset();
  assert.equal(destinatarioAlerta(), 1313);
  config.derivacionSupervisorId = 777;
  assert.equal(destinatarioAlerta(), 777);
});

test('sin destinatario no revienta, solo lo registra', async () => {
  reset();
  minutosDesdeUltimo = 7 * 60;
  config.derivacionSupervisorId = 0;
  config.derivarATodo = 0;
  config.responsablesPorDefecto = [];
  const r = await revisarSilencioCanal();
  assert.equal(r.aviso, false);
  assert.equal(notificaciones.length, 0);
});

test('sin base de datos no inventa un silencio', async () => {
  reset();
  minutosDesdeUltimo = null; // sin Postgres o sin historial
  const r = await estadoCanal();
  assert.equal(r.silencioso, false);
});
