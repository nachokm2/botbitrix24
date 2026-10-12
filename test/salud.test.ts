import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Salud de la integración. Hay dos caminos hacia Bitrix y fallan por separado: el webhook de
// administrador no caduca, el token OAuth sí. Cuando se rompe el segundo las conversaciones siguen
// —cada evento trae su propio token— pero los seguimientos, los avisos de derivación y el resumen
// semanal dejan de salir sin que nada lo diga. Fue el estado real de Postgrados durante días.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.BITRIX_WEBHOOK_URL = 'https://portal.test/rest/1/clave/';

let fallaOauth = false;
let fallaWebhook = false;
const notificaciones: any[] = [];
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: async (method: string, params: any) => {
      if (method === 'im.notify.personal.add') {
        notificaciones.push(params);
        return {};
      }
      if (fallaOauth) throw new Error('OAuth refresh: invalid_grant');
      return { ID: '1' };
    },
    callCrm: async () => {
      if (fallaWebhook) throw new Error('Bitrix crm.status.list: insufficient_scope');
      return [];
    },
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: {} }),
    callWebhook: async () => ({}),
  },
});

const auditCalls: any[] = [];
mock.module('../src/obs/audit.ts', { namedExports: { audit: async (e: any) => { auditCalls.push(e); } } });

let hayAuth = true;
mock.module('../src/store.ts', {
  namedExports: {
    getState: async () => ({ auth: hayAuth ? { domain: 'test.bitrix24.com', access_token: 'tok' } : null, botId: 1 }),
    setAuth: async () => {}, setBotId: async () => {}, setAppToken: async () => {},
    requireAuth: async () => ({ domain: 'test.bitrix24.com', access_token: 'tok' }),
    EMPTY_AUTH: { domain: '', access_token: '' },
  },
});

mock.module('../src/store/db.ts', {
  namedExports: {
    dbMinutosDesdeUltimoTurno: async () => 10,
    dbInsertAudit: async () => {},
    dbHuboOperadorDespuesDe: async () => false,
    dbDialogosConDeal: async () => [],
    dbDialogosPorTextoPrograma: async () => [],
  },
});

const { revisarSalud, revisarSaludYAvisar } = await import('../src/bitrix/salud');
const { config } = await import('../src/config');

function reset() {
  notificaciones.length = 0;
  auditCalls.length = 0;
  fallaOauth = false;
  fallaWebhook = false;
  hayAuth = true;
  config.derivacionSupervisorId = 1313;
}

test('con los dos caminos sanos no avisa', async () => {
  reset();
  const r = await revisarSaludYAvisar();
  assert.deepEqual({ oauth: r.oauth, webhook: r.webhook }, { oauth: 'ok', webhook: 'ok' });
  assert.equal(r.aviso, false);
  assert.equal(notificaciones.length, 0);
});

test('detecta el OAuth roto aunque el webhook esté sano', async () => {
  reset();
  fallaOauth = true;
  const r = await revisarSalud();
  assert.equal(r.oauth, 'roto');
  assert.equal(r.webhook, 'ok', 'el webhook no caduca: distinguirlos es el punto');
  assert.match(String(r.detalle), /invalid_grant/);
});

test('el aviso explica qué dejó de funcionar y qué no', async () => {
  reset();
  fallaOauth = true;
  const r = await revisarSaludYAvisar();
  assert.equal(r.aviso, true);
  assert.equal(notificaciones[0].USER_ID, 1313);
  assert.match(notificaciones[0].MESSAGE, /conversaciones siguen funcionando/);
  assert.match(notificaciones[0].MESSAGE, /seguimientos/);
  assert.match(notificaciones[0].MESSAGE, /reinstalando/, 'debe decir cómo se arregla');
  assert.ok(auditCalls.some((a) => a.type === 'integracion_rota'));
});

test('detecta el webhook roto', async () => {
  reset();
  fallaWebhook = true;
  const r = await revisarSalud();
  assert.equal(r.webhook, 'roto');
  assert.equal(r.oauth, 'ok');
});

test('sin token guardado lo reporta sin tratarlo como rotura', async () => {
  reset();
  hayAuth = false;
  const r = await revisarSalud();
  assert.equal(r.oauth, 'sin_token');
});

test('deja registro en auditoría aunque no haya a quién avisarle', async () => {
  reset();
  fallaOauth = true;
  config.derivacionSupervisorId = 0;
  config.derivarATodo = 0;
  config.responsablesPorDefecto = [];
  const r = await revisarSaludYAvisar();
  assert.equal(r.aviso, false);
  assert.ok(auditCalls.some((a) => a.type === 'integracion_rota'), 'el problema no se pierde');
});
