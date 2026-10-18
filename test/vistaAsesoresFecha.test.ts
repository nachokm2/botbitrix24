// Regresión del TypeError de vistaPorAsesor (hallazgo PAN-01).
//
// dbDerivaciones declara `ts: string` pero pg entrega un Date (OID 1184). El orden final de los casos
// usaba `derivadoEn.localeCompare(...)`, que no existe en Date: al desempatar dos casos con el mismo
// "atendido" lanzaba un TypeError y dejaba vacías "Seguimiento por asesor" y "Casos derivados" del panel.
// Esta prueba monta el MISMO parser de pg (así la fila es idéntica a producción) y exige que ya NO lance
// y que el orden sea el esperado (sin tomar primero, y dentro de eso lo más reciente).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import pgTypes from 'pg-types';

process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.DATABASE_URL = 'postgres://ficticio@127.0.0.1:1/ficticio'; // Pool simulado: nunca conecta
process.env.MARCA = '';

const parseTimestamptz = pgTypes.getTypeParser(1184, 'text');
const textoPg = (d: Date) => d.toISOString().replace('T', ' ').replace('Z', '+00');
const hace = (h: number) => new Date(Date.now() - h * 3600_000);

let derivacionesBD: Array<{ dealId: number; haceH: number; tipo: string; dialog: string }> = [];
class FakePool {
  constructor(_o: unknown) {}
  on() { return this; }
  async query(sql: string) {
    if (/array_agg\(type ORDER BY ts\)/.test(sql) && /GROUP BY crm_entity/.test(sql)) {
      return {
        rows: derivacionesBD.map((d) => ({
          crm_entity: `deal#${d.dealId}`,
          ts: parseTimestamptz(textoPg(hace(d.haceH))), // Date real, como pg en producción
          dialog_id: d.dialog,
          motivo: d.tipo,
        })),
      };
    }
    return { rows: [] };
  }
  async end() {}
}
mock.module('pg', { defaultExport: { Pool: FakePool, types: pgTypes } });

let dealsBitrix: Array<Record<string, any>> = [];
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callCrm: async (method: string, params: any) => {
      if (method === 'crm.deal.list' && params?.filter?.['@ID']) {
        const ids: number[] = params.filter['@ID'].map(Number);
        return dealsBitrix.filter((d) => ids.includes(Number(d.ID))).slice(0, 50);
      }
      return [];
    },
    callBitrix: async () => ({}),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: [] }),
    callWebhook: async () => ({}),
  },
});
mock.module('../src/crm/directory.ts', {
  namedExports: {
    getUsuarios: async (ids: number[]) => ids.map((id) => ({ id, nombre: `Asesor ${id}`, activo: true })),
    getDealInfo: async () => null, getDealAsesores: async () => [], esEmpleadoBitrix: async () => false,
    getIdentidadAsesor: async () => null, getDatosConocidosDeEntidades: async () => ({}),
  },
});

const db = await import('../src/store/db.ts');
await db.initDb();
const { vistaPorAsesor } = await import('../src/crm/vistaAsesores.ts');
const auth = { domain: 'portal.bitrix24.test', access_token: 'tok' } as any;

function escenario() {
  derivacionesBD = [
    { dealId: 101, haceH: 30, tipo: 'tool_call', dialog: 'chat101' },
    { dealId: 102, haceH: 20, tipo: 'seguimiento_transferencia', dialog: 'chat102' },
    { dealId: 103, haceH: 10, tipo: 'auto_escalation', dialog: 'chat103' },
  ];
  dealsBitrix = [
    { ID: '101', ASSIGNED_BY_ID: '500', MOVED_BY_ID: '500', MOVED_TIME: hace(28).toISOString(), STAGE_ID: 'C1:PREPARATION', TITLE: 'Deal 101', CATEGORY_ID: '1' },
    { ID: '102', ASSIGNED_BY_ID: '500', MOVED_BY_ID: '', MOVED_TIME: null, STAGE_ID: 'C1:NEW', TITLE: 'Deal 102', CATEGORY_ID: '1' },
    { ID: '103', ASSIGNED_BY_ID: '600', MOVED_BY_ID: '', MOVED_TIME: null, STAGE_ID: 'C1:NEW', TITLE: 'Deal 103', CATEGORY_ID: '1' },
  ];
}

test('dbDerivaciones entrega ts como Date (la premisa del bug)', async () => {
  escenario();
  const der = await db.dbDerivaciones('all');
  assert.ok((der[0].ts as any) instanceof Date);
});

test('con Date real, vistaPorAsesor ya NO lanza y calcula las filas esperadas', async () => {
  escenario();
  const v = await vistaPorAsesor(auth, 'all');
  assert.deepEqual(
    v.filas.map((f) => [f.id, f.derivados, f.atendidos, f.pendientes, f.medianaSeg]),
    [[500, 2, 1, 1, 7200], [600, 1, 0, 1, null]],
  );
});

test('dos casos con el mismo "atendido" (el que antes lanzaba) se ordenan por fecha, más reciente primero', async () => {
  escenario();
  derivacionesBD = derivacionesBD.slice(1, 3); // 102 y 103, ambos pendientes
  const v = await vistaPorAsesor(auth, 'all');
  assert.deepEqual(v.casos.map((c) => c.dealId), [103, 102]); // 103 es más reciente
});

test('orden global: sin tomar primero y, dentro de eso, lo más reciente', async () => {
  escenario();
  const v = await vistaPorAsesor(auth, 'all');
  assert.deepEqual(v.casos.map((c) => c.dealId), [103, 102, 101]); // 101 está atendido → al final
  assert.deepEqual(v.casos.map((c) => c.atendido), [false, false, true]);
});
