import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Resguardos de movimiento de etapa (auditoría BIT-01 y BIT-03).
//
// BIT-01: al derivar, el bot devolvía a "Derivados Bot" negociaciones que ya estaban más adelante
// —incluida la "Pendiente de Firma" que había puesto él mismo— y leía su propio movimiento como si
// lo hubiera hecho un asesor.
// BIT-03: el scoring movía la etapa sin leerla: retrocedía de "Postulante" a "Interesado" cuando el
// puntaje bajaba unos puntos y reabría negociaciones ganadas.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.BITRIX_USUARIOS_AUTOMATICOS = '45';

const almacen = new Map<string, string>();
const redis = {
  get: async (k: string) => almacen.get(k) ?? null,
  set: async (k: string, v: string) => {
    almacen.set(k, v);
    return 'OK';
  },
};
mock.module('../src/store/kv.ts', {
  namedExports: {
    getRedisClient: () => redis,
    once: async () => true,
    kvDel: async () => {},
    getJson: async () => null,
    getJsonOrThrow: async () => null,
    setJson: async () => {},
  },
});

let ultimaDerivacion: number | null = null;
mock.module('../src/store/db.ts', {
  namedExports: {
    dbUltimaDerivacion: async () => ultimaDerivacion,
    dbInsertAudit: async () => {},
    dbDerivaciones: async () => [],
    dbDialogosConDeal: async () => [],
    dbHuboOperadorDespuesDe: async () => false,
    dbDialogosPorTextoPrograma: async () => [],
  },
});

// Embudo 73 en el orden de Bitrix: Nuevo → Derivados Bot → Contactando → Pendiente de Firma.
// Embudo 1 (scoring): Nuevo → Interesado → Postulante.
const ETAPAS: Record<string, { STATUS_ID: string; SORT: number }[]> = {
  DEAL_STAGE_73: [
    { STATUS_ID: 'C73:NEW', SORT: 10 },
    { STATUS_ID: 'C73:UC_9HGHNN', SORT: 20 },
    { STATUS_ID: 'C73:UC_CONTACT', SORT: 30 },
    { STATUS_ID: 'C73:EXECUTING', SORT: 40 },
    { STATUS_ID: 'C73:WON', SORT: 50 },
  ],
  DEAL_STAGE_1: [
    { STATUS_ID: 'C1:NEW', SORT: 10 },
    { STATUS_ID: 'C1:MEDIO', SORT: 20 },
    { STATUS_ID: 'C1:ALTO', SORT: 30 },
    { STATUS_ID: 'C1:WON', SORT: 40 },
  ],
};
const BOT_ID = 4173;
let deal: any = {};
let sinOrden = false;
const llamadas: any[] = [];
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callCrm: async (method: string, params: any) => {
      llamadas.push({ method, params });
      if (method === 'crm.deal.get') return deal;
      if (method === 'crm.status.list') return sinOrden ? [] : (ETAPAS[params.filter.ENTITY_ID] ?? []);
      if (method === 'user.current') return { ID: String(BOT_ID) };
      return {};
    },
    callBitrix: async () => ({}),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: {} }),
    callWebhook: async () => ({}),
  },
});

const { moverAEtapaDerivado, derivacionYaGestionada } = await import('../src/crm/embudos');
const { esAvance, revisarMovimientoPorScore, _resetEtapasCache } = await import('../src/crm/etapas');
const { config } = await import('../src/config');
const auth = { domain: 'test.bitrix24.com', access_token: 'tok' } as any;
const movida = () => llamadas.find((c) => c.method === 'crm.deal.update');

function reset(d: any) {
  llamadas.length = 0;
  almacen.clear();
  ultimaDerivacion = null;
  sinOrden = false;
  deal = d;
  _resetEtapasCache();
  config.stageDerivado = { 73: 'C73:UC_9HGHNN' };
  config.stageProtegidasDerivacion = [];
}

test('esAvance: compara por el orden real del embudo', async () => {
  reset({});
  assert.equal(await esAvance(73, 'C73:NEW', 'C73:UC_9HGHNN', auth), true);
  assert.equal(await esAvance(73, 'C73:UC_CONTACT', 'C73:UC_9HGHNN', auth), false);
  assert.equal(await esAvance(73, 'C73:DESCONOCIDA', 'C73:UC_9HGHNN', auth), null);
});

// ---- BIT-01 ----

test('BIT-01: desde una etapa anterior sí se mueve a "Derivados Bot"', async () => {
  reset({ CATEGORY_ID: '73', STAGE_ID: 'C73:NEW', CLOSED: 'N' });
  assert.equal(await moverAEtapaDerivado(700, auth), true);
  assert.equal(movida()!.params.fields.STAGE_ID, 'C73:UC_9HGHNN');
});

test('BIT-01: Pendiente de Firma (más adelante) no vuelve a "Derivados Bot", aunque no esté en la lista protegida', async () => {
  reset({ CATEGORY_ID: '73', STAGE_ID: 'C73:EXECUTING', CLOSED: 'N' });
  assert.equal(await moverAEtapaDerivado(701, auth), false);
  assert.equal(movida(), undefined);
});

test('BIT-01: una etapa que avanzó un asesor (Contactando) tampoco retrocede en la primera derivación', async () => {
  reset({ CATEGORY_ID: '73', STAGE_ID: 'C73:UC_CONTACT', CLOSED: 'N' });
  assert.equal(await moverAEtapaDerivado(702, auth), false);
  assert.equal(movida(), undefined);
});

test('BIT-01: sin orden de etapas rigen los resguardos de antes (no se bloquea todo)', async () => {
  reset({ CATEGORY_ID: '73', STAGE_ID: 'C73:NEW', CLOSED: 'N' });
  sinOrden = true;
  assert.equal(await moverAEtapaDerivado(703, auth), true);
});

test('BIT-01: el movimiento que firmó el propio bot no cuenta como gestión de un asesor', async () => {
  const marca = Date.now() - 60 * 60_000;
  reset({ MOVED_BY_ID: String(BOT_ID), MOVED_TIME: new Date(marca + 10 * 60_000).toISOString() });
  ultimaDerivacion = marca;
  assert.equal(await derivacionYaGestionada(704, auth), false);
});

test('BIT-01: el movimiento de una persona después de la derivación sí cuenta', async () => {
  const marca = Date.now() - 60 * 60_000;
  reset({ MOVED_BY_ID: '321', MOVED_TIME: new Date(marca + 10 * 60_000).toISOString() });
  ultimaDerivacion = marca;
  assert.equal(await derivacionYaGestionada(705, auth), true);
});

// ---- BIT-03 ----

const creado = new Date(Date.now() - 3 * 3600_000).toISOString();

test('BIT-03: una negociación ganada no se mueve por puntaje', async () => {
  reset({ CATEGORY_ID: '1', STAGE_ID: 'C1:WON', CLOSED: 'Y', DATE_CREATE: creado, MOVED_TIME: creado });
  const r = await revisarMovimientoPorScore(800, 'C1:MEDIO', auth);
  assert.equal(r.mover, false);
  assert.equal(r.motivo, 'cerrada');
});

test('BIT-03: si el puntaje baja de 74 a 66, no retrocede de Postulante a Interesado', async () => {
  // El bot la había movido a "alto": MOVED_BY_ID es el usuario del bot.
  reset({ CATEGORY_ID: '1', STAGE_ID: 'C1:ALTO', CLOSED: 'N', DATE_CREATE: creado, MOVED_TIME: new Date().toISOString(), MOVED_BY_ID: String(BOT_ID) });
  const r = await revisarMovimientoPorScore(801, 'C1:MEDIO', auth);
  assert.equal(r.mover, false);
  assert.equal(r.motivo, 'retroceso');
  assert.equal(r.actual, 'C1:ALTO');
});

test('BIT-03: avanzar sí se permite', async () => {
  reset({ CATEGORY_ID: '1', STAGE_ID: 'C1:NEW', CLOSED: 'N', DATE_CREATE: creado, MOVED_TIME: creado });
  const r = await revisarMovimientoPorScore(802, 'C1:ALTO', auth);
  assert.equal(r.mover, true);
});

test('BIT-03: si la etapa la movió una persona, el puntaje no la toca', async () => {
  reset({ CATEGORY_ID: '1', STAGE_ID: 'C1:NEW', CLOSED: 'N', DATE_CREATE: creado, MOVED_TIME: new Date().toISOString(), MOVED_BY_ID: '321' });
  const r = await revisarMovimientoPorScore(803, 'C1:ALTO', auth);
  assert.equal(r.mover, false);
  assert.equal(r.motivo, 'movida_por_persona');
});

test('BIT-03: el robot de Remarketing (#45) no cuenta como persona', async () => {
  reset({ CATEGORY_ID: '1', STAGE_ID: 'C1:NEW', CLOSED: 'N', DATE_CREATE: creado, MOVED_TIME: new Date().toISOString(), MOVED_BY_ID: '45' });
  assert.equal((await revisarMovimientoPorScore(804, 'C1:ALTO', auth)).mover, true);
});

test('BIT-03: si el deal cambió de embudo no se escribe una etapa de otro embudo', async () => {
  reset({ CATEGORY_ID: '3', STAGE_ID: 'C3:NEW', CLOSED: 'N', DATE_CREATE: creado, MOVED_TIME: creado });
  const r = await revisarMovimientoPorScore(805, 'C1:ALTO', auth);
  assert.equal(r.mover, false);
  assert.equal(r.motivo, 'otro_embudo');
  assert.equal(r.categoria, 3, 'devuelve el embudo real para refrescar la sesión');
});

test('BIT-03: sin orden de etapas no se mueve (falla cerrado)', async () => {
  reset({ CATEGORY_ID: '1', STAGE_ID: 'C1:NEW', CLOSED: 'N', DATE_CREATE: creado, MOVED_TIME: creado });
  sinOrden = true;
  const r = await revisarMovimientoPorScore(806, 'C1:ALTO', auth);
  assert.equal(r.mover, false);
  assert.equal(r.motivo, 'orden_desconocido');
});
