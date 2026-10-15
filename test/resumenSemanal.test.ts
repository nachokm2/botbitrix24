import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Resumen semanal empujado a Bitrix. El panel existe y está completo, pero hay que acordarse de
// abrirlo: durante el piloto, los números que movieron decisiones fueron siempre los que alguien
// pidió expresamente. Esto los manda solo, y corto: un informe largo no se lee.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.RESUMEN_SEMANAL_USUARIOS = '1313,99';

let agg: any = null;
let hallazgos: any[] = [];
mock.module('../src/store/db.ts', {
  namedExports: {
    dbUltimaDerivacion: async () => null,
    dbMetricsSummary: async () => agg,
    dbHallazgosRecientes: async () => hallazgos,
    dbDerivaciones: async () => [],
    dbInsertAudit: async () => {},
    dbHuboOperadorDespuesDe: async () => false,
    dbDialogosConDeal: async () => [],
    dbDialogosPorTextoPrograma: async () => [],
  },
});

let asesores: any[] = [];
mock.module('../src/crm/vistaAsesores.ts', { namedExports: { vistaPorAsesor: async () => ({ filas: asesores, porMotivo: {} }) } });

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

mock.module('../src/obs/audit.ts', { namedExports: { audit: async () => {} } });
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

const { redactarResumen, enviarResumenSemanal, diaEnChile } = await import('../src/ai/resumenSemanal');

const base = {
  conversaciones: 40,
  capturaConvs: 20,
  escalConvs: 10,
  errores: 0,
  pendientesPorAsesor: [],
  hallazgosGraves: 0,
  topProgramas: [],
};

test('informa volumen y porcentajes de captura y derivación', async () => {
  const t = redactarResumen({ ...base });
  assert.match(t, /40 conversaciones atendidas/);
  assert.match(t, /Datos capturados en 20 \(50%\)/);
  assert.match(t, /derivadas a un asesor 10 \(25%\)/);
});

test('los casos sin trabajar van con nombre: es lo único accionable hoy', async () => {
  const t = redactarResumen({
    ...base,
    pendientesPorAsesor: [
      { nombre: 'Ignacio Ribera', pendientes: 5 },
      { nombre: 'Ana Pérez', pendientes: 2 },
      { nombre: 'Luis Soto', pendientes: 0 },
    ],
  });
  assert.match(t, /7 casos derivados siguen sin trabajar/);
  assert.match(t, /Ignacio Ribera \(5\)/);
  assert.doesNotMatch(t, /Luis Soto/, 'quien no tiene pendientes no se nombra');
});

test('si no quedó nada pendiente, lo dice en vez de callarlo', async () => {
  const t = redactarResumen({ ...base, pendientesPorAsesor: [{ nombre: 'Ana', pendientes: 0 }] });
  assert.match(t, /Todos los casos derivados fueron trabajados/);
});

test('una semana sin conversaciones no inventa porcentajes sobre cero', async () => {
  const t = redactarResumen({ ...base, conversaciones: 0, capturaConvs: 0, escalConvs: 0 });
  assert.match(t, /no atendió conversaciones/);
  assert.doesNotMatch(t, /%/);
});

test('fallas y hallazgos graves se mencionan solo si los hay', async () => {
  assert.doesNotMatch(redactarResumen({ ...base }), /Para mirar/);
  const t = redactarResumen({ ...base, errores: 3, hallazgosGraves: 2 });
  assert.match(t, /3 fallas técnicas y 2 hallazgos graves/);
});

test('se envía a cada destinatario configurado', async () => {
  notificaciones.length = 0;
  agg = { conversaciones: 10, capturaConvs: 5, escalConvs: 3, errores: 0, topProgramas: [{ k: 'Psicología', c: 4 }] };
  hallazgos = [{ gravedad: 'alta' }, { gravedad: 'baja' }];
  asesores = [{ nombre: 'Ignacio Ribera', pendientes: 2 }];

  const texto = await enviarResumenSemanal();
  assert.ok(texto);
  assert.equal(notificaciones.length, 2);
  assert.deepEqual(notificaciones.map((n) => n.USER_ID), [1313, 99]);
  assert.match(notificaciones[0].MESSAGE, /Psicología \(4\)/);
  assert.match(notificaciones[0].MESSAGE, /1 hallazgos graves/);
});

test('sin métricas en la base no manda un mensaje vacío', async () => {
  notificaciones.length = 0;
  agg = null;
  assert.equal(await enviarResumenSemanal(), null);
  assert.equal(notificaciones.length, 0);
});

test('diaEnChile usa la zona de Chile, no la del servidor', () => {
  // En octubre Chile está en UTC-3: las 02:00 UTC del lunes son todavía las 23:00 del domingo.
  assert.equal(diaEnChile(new Date('2026-10-12T02:00:00Z')), 0);
  assert.equal(diaEnChile(new Date('2026-10-12T15:00:00Z')), 1);
});
