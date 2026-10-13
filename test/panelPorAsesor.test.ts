import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// El desglose "Por asesor" del panel debe contar solo los embudos de la marca. Los dos bots
// comparten portal de Bitrix: el bot evalúa cualquier conversación que le llega, y el responsable
// de esa negociación puede ser de otro equipo. En el panel de Carver aparecían ocho asesores de
// Postgrados.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.DATABASE_URL = 'postgres://fake/fake';

const consultas: string[] = [];
mock.module('pg', {
  defaultExport: {
    Pool: class {
      async query(sql: string) {
        consultas.push(String(sql));
        return { rows: [], rowCount: 0 };
      }
      async end() {}
      on() {}
    },
  },
});

const { initDb, dbMetricsSummary } = await import('../src/store/db');
const { config } = await import('../src/config');

await initDb();

const consultaAsesores = () => consultas.find((s) => s.includes("detail->>'responsableId' id"));

test('con embudos propios configurados, la consulta los filtra', async () => {
  config.embudosPropios = [73, 135];
  consultas.length = 0;
  await dbMetricsSummary('7d');
  const sql = consultaAsesores();
  assert.ok(sql, 'debe existir la consulta por asesor');
  assert.match(sql!, /categoryId' IN \('73','135'\)/);
});

test('sin embudos configurados no filtra: no cambia nada donde no hace falta', async () => {
  config.embudosPropios = [];
  consultas.length = 0;
  await dbMetricsSummary('7d');
  assert.doesNotMatch(consultaAsesores()!, /categoryId' IN/);
});

test('un valor no entero no llega a la consulta', async () => {
  // Se interpola en SQL: el segundo filtro existe para que un valor raro nunca llegue ahí.
  config.embudosPropios = [73, 1.5 as any, -2 as any];
  consultas.length = 0;
  await dbMetricsSummary('7d');
  assert.match(consultaAsesores()!, /categoryId' IN \('73'\)/);
  config.embudosPropios = [];
});
