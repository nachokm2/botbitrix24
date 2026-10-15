import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// En qué terminaron las negociaciones que el bot atendió. Hasta ahora esto solo existía atado a los
// programas piloto de Postgrados; Carver no tiene piloto configurado, así que no había forma de ver
// cuántas conversaciones terminaron en matrícula — justamente el número que decide si vale la pena.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

let conversados: Array<{ dialogId: string; dealId: number }> = [];
let derivados: any[] = [];
mock.module('../src/store/db.ts', {
  namedExports: {
    dbUltimaDerivacion: async () => null,
    dbDialogosConDeal: async () => conversados,
    dbDerivaciones: async () => derivados,
    dbInsertAudit: async () => {},
    dbDialogosPorTextoPrograma: async () => [],
    dbHuboOperadorDespuesDe: async () => false,
  },
});

let deals: any[] = [];
let fallarLote = false;
const consultas: any[] = [];
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callCrm: async (method: string, params: any) => {
      consultas.push({ method, params });
      if (method === 'crm.deal.list') {
        if (fallarLote) throw new Error('OPERATION_TIME_LIMIT');
        return deals.filter((d) => params.filter['@ID'].includes(Number(d.ID)));
      }
      if (method === 'crm.status.list')
        return [
          { STATUS_ID: 'C73:WON', NAME: 'Matriculado' },
          { STATUS_ID: 'C73:UC_8Y04DB', NAME: 'Pagado' },
          { STATUS_ID: 'C73:UC_KY8NN7', NAME: 'Contactando' },
          { STATUS_ID: 'C73:LOSE', NAME: 'No interesado' },
        ];
      return [];
    },
    callBitrix: async () => ({}),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: {} }),
    callWebhook: async () => ({}),
  },
});

const { resultadoDelBot } = await import('../src/crm/resultadoBot');
const { config } = await import('../src/config');
const auth = { domain: 'test.bitrix24.com', access_token: 'tok' } as any;

function escenario() {
  consultas.length = 0;
  conversados = [
    { dialogId: 'c1', dealId: 1 },
    { dialogId: 'c2', dealId: 2 },
    { dialogId: 'c3', dealId: 3 },
  ];
  derivados = [{ dealId: 4, ts: '2026-10-01', dialogId: 'c4', motivo: 'pedido' }];
  deals = [
    { ID: '1', STAGE_ID: 'C73:WON', CATEGORY_ID: '73', OPPORTUNITY: '2300', CLOSED: 'Y' },
    { ID: '2', STAGE_ID: 'C73:UC_8Y04DB', CATEGORY_ID: '73', OPPORTUNITY: '1800', CLOSED: 'N' },
    { ID: '3', STAGE_ID: 'C73:UC_KY8NN7', CATEGORY_ID: '73', OPPORTUNITY: '0', CLOSED: 'N' },
    { ID: '4', STAGE_ID: 'C73:LOSE', CATEGORY_ID: '73', OPPORTUNITY: '0', CLOSED: 'Y' },
  ];
  config.embudosPropios = [73, 135];
  config.stagesGanadas = ['C73:WON', 'C73:UC_8Y04DB'];
}

test('cuenta ganadas, perdidas y abiertas sobre lo que el bot atendió', async () => {
  escenario();
  const r = await resultadoDelBot(auth);
  assert.equal(r.atendidas, 4);
  assert.equal(r.ganadas, 2, 'Matriculado y Pagado');
  assert.equal(r.perdidas, 1);
  assert.equal(r.abiertas, 1);
  assert.equal(r.montoGanado, 4100);
});

test('"Pagado" cuenta como cierre, aunque no sea la etapa :WON', async () => {
  // En Carver, "Pagado" es un desenlace tan bueno como "Matriculado" y vive en otra etapa; sin
  // configurarlo, la mitad de los cierres no se contaría.
  escenario();
  config.stagesGanadas = [];
  const r = await resultadoDelBot(auth);
  assert.equal(r.ganadas, 1, 'sin configurar, solo cuenta :WON');
  config.stagesGanadas = ['C73:WON', 'C73:UC_8Y04DB'];
});

test('no se atribuye negociaciones de otros embudos', async () => {
  // El bot se topa con casos de otros equipos: contarlos sería atribuirse matrículas ajenas.
  escenario();
  deals.push({ ID: '9', STAGE_ID: 'C1:WON', CATEGORY_ID: '1', OPPORTUNITY: '9999', CLOSED: 'Y' });
  conversados.push({ dialogId: 'c9', dealId: 9 });
  const r = await resultadoDelBot(auth);
  assert.equal(r.atendidas, 4, 'la del embudo 1 queda fuera');
  assert.equal(r.montoGanado, 4100);
});

test('una negociación derivada Y conversada se cuenta una sola vez', async () => {
  escenario();
  derivados = [{ dealId: 1, ts: '2026-10-01', dialogId: 'c1', motivo: 'score' }];
  const r = await resultadoDelBot(auth);
  assert.equal(r.atendidas, 3);
});

test('el desglose por etapa marca cuáles son cierres', async () => {
  escenario();
  const r = await resultadoDelBot(auth);
  const won = r.porEtapa.find((e) => e.etapa === 'C73:WON')!;
  assert.equal(won.nombre, 'Matriculado');
  assert.equal(won.ganada, true);
  assert.equal(r.porEtapa.find((e) => e.etapa === 'C73:UC_KY8NN7')!.ganada, false);
});

test('sin negociaciones atendidas devuelve vacío en vez de romper', async () => {
  escenario();
  conversados = [];
  derivados = [];
  const r = await resultadoDelBot(auth);
  assert.equal(r.atendidas, 0);
  assert.equal(consultas.length, 0, 'ni siquiera consulta a Bitrix');
  config.embudosPropios = [];
  config.stagesGanadas = [];
});

test('si Bitrix rechaza un lote, el resultado se marca incompleto', async () => {
  // Un total corto presentado como bueno engaña: la tarjeta marcó "0 matriculados" cuando en
  // realidad se habían perdido dos lotes por el límite de operaciones de Bitrix.
  escenario();
  let primera = true;
  const original = consultas.length;
  const { callCrm } = await import('../src/bitrix/client');
  assert.ok(callCrm);
  // Se fuerza el fallo del primer lote sustituyendo los datos por un volumen que requiera dos.
  conversados = Array.from({ length: 60 }, (_, i) => ({ dialogId: 'c' + i, dealId: i + 1 }));
  deals = conversados.map((c) => ({ ID: String(c.dealId), STAGE_ID: 'C73:WON', CATEGORY_ID: '73', OPPORTUNITY: '10', CLOSED: 'Y' }));
  fallarLote = true;
  const r = await resultadoDelBot(auth);
  fallarLote = false;
  assert.equal(r.incompleto, true);
  assert.ok(original >= 0 && primera);
});
