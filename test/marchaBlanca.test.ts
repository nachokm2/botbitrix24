import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// bitrixMarchaBlancaScorecard: para cada deal escalado a un asesor (round-robin, ver
// crm/asignacionAsesores.ts), trae su etapa ACTUAL en Bitrix + si ya matriculó — para que el panel
// pueda mostrar "Deals escalados a asesor" (pedido del usuario: verificar matrículas de los 2
// programas piloto viendo dónde quedó cada deal, no solo un conteo agregado).
process.env.NODE_ENV = 'test';
process.env.BITRIX_UF_PROGRAMA = 'UF_CRM_PROGRAMA_TEST';

type Call = { method: string; params: any };
const calls: Call[] = [];
let dealesPorId: Record<number, { TITLE?: string; STAGE_ID?: string; ASSIGNED_BY_ID?: string }> = {};

mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: async (method: string, params: any) => record(method, params),
    callCrm: async (method: string, params: any) => record(method, params),
    callBitrixEnvelope: async (method: string, params: any) => ({ result: record(method, params), total: 0 }),
    callCrmEnvelope: async (method: string, params: any) => ({ result: [], total: 0, next: null }),
    callWebhook: async () => ({}),
  },
});
function record(method: string, params: any): any {
  calls.push({ method, params });
  if (method === 'crm.deal.get') return dealesPorId[params.id] ?? {};
  if (method === 'crm.status.list') {
    return [
      { STATUS_ID: 'C1:NEW', NAME: 'Asignación' },
      { STATUS_ID: 'C1:UC_JARL1O', NAME: 'Contactado' },
      { STATUS_ID: 'C1:WON', NAME: 'Matrícula' },
    ];
  }
  return {};
}

const { bitrixMarchaBlancaScorecard } = await import('../src/crm/marchaBlanca');
const auth = { domain: 'test.bitrix24.com', access_token: 'tok' } as any;

test('bitrixMarchaBlancaScorecard: arma el detalle por deal escalado (etapa, asesor, motivo, matrícula)', async () => {
  calls.length = 0;
  dealesPorId = {
    401: { TITLE: 'Deal Juan Pérez', STAGE_ID: 'C1:WON', ASSIGNED_BY_ID: '283901' }, // Zaida (Norte IA)
    402: { TITLE: 'Deal María López', STAGE_ID: 'C1:UC_JARL1O', ASSIGNED_BY_ID: '368819' }, // Constanza (Sur IA)
  };
  const botStats = new Map([
    ['ia', { escalados: [
      { dealId: 401, motivo: 'explicito' as const },
      { dealId: 402, motivo: 'silencio' as const },
    ] }],
  ]);

  const out = await bitrixMarchaBlancaScorecard(botStats, auth);
  const ia = out.find((p) => p.key === 'ia')!;

  assert.equal(ia.escaladosConDeal, 2);
  assert.equal(ia.escaladosMatriculados, 1, 'solo el deal 401 (WON) matriculó');

  const d401 = ia.escaladosDetalle.find((d) => d.dealId === 401)!;
  assert.equal(d401.titulo, 'Deal Juan Pérez');
  assert.equal(d401.asesor, 'Zaida Verdugo', 'resuelve el nombre por ASSIGNED_BY_ID conocido, no deja el ID crudo');
  assert.equal(d401.motivo, 'explicito');
  assert.equal(d401.stageNombre, 'Matrícula', 'usa el nombre real de la etapa (crm.status.list), no el STATUS_ID crudo');
  assert.equal(d401.matriculado, true);

  const d402 = ia.escaladosDetalle.find((d) => d.dealId === 402)!;
  assert.equal(d402.asesor, 'Constanza Huitraiqueo Garabito');
  assert.equal(d402.motivo, 'silencio');
  assert.equal(d402.stageNombre, 'Contactado');
  assert.equal(d402.matriculado, false);
});

test('bitrixMarchaBlancaScorecard: sin escalados, escaladosDetalle queda vacío (no llama crm.deal.get de más)', async () => {
  calls.length = 0;
  dealesPorId = {};
  const botStats = new Map([['ia', { escalados: [] }]]);

  const out = await bitrixMarchaBlancaScorecard(botStats, auth);
  const ia = out.find((p) => p.key === 'ia')!;

  assert.deepEqual(ia.escaladosDetalle, []);
  assert.ok(!calls.find((c) => c.method === 'crm.deal.get'));
});
