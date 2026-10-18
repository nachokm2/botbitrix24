import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// El bot devolvía a "Derivados Bot" negociaciones que un asesor ya había tomado.
//
// La secuencia real: el cliente queda en silencio y se programa una transferencia; el asesor toma la
// negociación y la mueve a "Contactando"; un rato después vence esa transferencia —programada ANTES
// de que el asesor la tomara— y el bot la devuelve a "Derivados Bot" sin que el cliente haya escrito
// nada. Al asesor se le deshace el trabajo en silencio.
//
// Lo que fallaba: el barrido solo miraba `humanTookOver`, que se marca cuando alguien escribe EN EL
// CHAT. Un asesor que trabaja el lead en el CRM nunca lo marca. Ahora se mira el CRM.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.BITRIX_USUARIOS_AUTOMATICOS = '45';

// Redis de mentira: solo lo que usa el módulo (get/set con EX).
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

let deal: any = {};
const llamadas: any[] = [];
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callCrm: async (method: string, params: any) => {
      llamadas.push({ method, params });
      if (method === 'crm.deal.get') return deal;
      if (method === 'crm.deal.update') {
        Object.assign(deal, params.fields);
        return true;
      }
      return {};
    },
    callBitrix: async () => ({}),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: {} }),
    callWebhook: async () => ({}),
  },
});

const { moverAEtapaDerivado, derivacionYaGestionada } = await import('../src/crm/embudos');
const { config } = await import('../src/config');
const auth = { domain: 'test.bitrix24.com', access_token: 'tok' } as any;

const ASESOR = 479681;
const ROBOT = 45;
const movidas = () => llamadas.filter((c) => c.method === 'crm.deal.update');

function reset() {
  llamadas.length = 0;
  almacen.clear();
  ultimaDerivacion = null;
  deal = { CATEGORY_ID: '73', STAGE_ID: 'C73:UC_KY8NN7', CLOSED: 'N', MOVED_BY_ID: '0', MOVED_TIME: null };
  config.stageDerivado = { 73: 'C73:UC_9HGHNN' };
  config.embudosPropios = [73, 135];
}

test('la PRIMERA derivación sí mueve la negociación', async () => {
  // Sin marca previa el bot nunca la movió: no hay trabajo de nadie que deshacer.
  reset();
  assert.equal(await moverAEtapaDerivado(5001, auth), true);
  assert.equal(deal.STAGE_ID, 'C73:UC_9HGHNN');
});

test('EL BUG: si el asesor la movió después, el bot NO la devuelve', async () => {
  reset();
  // 1. El bot deriva y la mueve.
  assert.equal(await moverAEtapaDerivado(5002, auth), true);
  assert.equal(deal.STAGE_ID, 'C73:UC_9HGHNN');

  // 2. El asesor la toma y la mueve a Contactando.
  deal.STAGE_ID = 'C73:UC_KY8NN7';
  deal.MOVED_BY_ID = String(ASESOR);
  deal.MOVED_TIME = new Date(Date.now() + 60_000).toISOString();

  // 3. Vence la transferencia programada antes: ya no debe devolverla.
  llamadas.length = 0;
  assert.equal(await moverAEtapaDerivado(5002, auth), false);
  assert.equal(deal.STAGE_ID, 'C73:UC_KY8NN7', 'la negociación se queda donde la dejó el asesor');
  assert.equal(movidas().length, 0, 'ni siquiera intenta escribir');
});

test('el barrido automático a Remarketing no cuenta como gestión de nadie', async () => {
  // El robot "Resp. Autom." (#45) barre a RMKT lo que nadie tocó: eso no es un asesor trabajando.
  reset();
  await moverAEtapaDerivado(5003, auth);
  deal.STAGE_ID = 'C73:APOLOGY';
  deal.MOVED_BY_ID = String(ROBOT);
  deal.MOVED_TIME = new Date(Date.now() + 60_000).toISOString();

  assert.equal(await derivacionYaGestionada(5003, auth), false);
});

test('el propio movimiento del bot no se confunde con la gestión de un asesor', async () => {
  // La marca se escribe DESPUÉS del update, por encima del MOVED_TIME que Bitrix acaba de poner por
  // ese mismo cambio. Sin eso, el bot se leía a sí mismo como "alguien ya lo trabajó".
  reset();
  const antes = Date.now() - 1000;
  deal.MOVED_BY_ID = '4173'; // el usuario del webhook, que es quien escribe por el bot
  deal.MOVED_TIME = new Date(antes).toISOString();
  await moverAEtapaDerivado(5004, auth);

  assert.equal(await derivacionYaGestionada(5004, auth), false, 'su propio movimiento no lo bloquea');
});

test('sin que nadie la mueva, una derivación posterior sigue funcionando', async () => {
  reset();
  await moverAEtapaDerivado(5005, auth);
  deal.STAGE_ID = 'C73:UC_KY8NN7'; // alguien la movió… pero Bitrix no dice quién ni cuándo
  deal.MOVED_BY_ID = '0';
  deal.MOVED_TIME = null;

  assert.equal(await derivacionYaGestionada(5005, auth), false, 'ante la duda, se deriva');
  assert.equal(await moverAEtapaDerivado(5005, auth), true);
});

test('si Bitrix no responde, se deriva igual', async () => {
  // Mejor una derivación de más que perder un caso que nadie tomó.
  reset();
  await moverAEtapaDerivado(5006, auth);
  const original = deal;
  deal = null; // crm.deal.get devuelve vacío
  assert.equal(await derivacionYaGestionada(5006, auth), false);
  deal = original;
});

test('una negociación de la que el bot no tiene marca nunca se considera gestionada', async () => {
  reset();
  deal.MOVED_BY_ID = String(ASESOR);
  deal.MOVED_TIME = new Date().toISOString();
  assert.equal(await derivacionYaGestionada(5007, auth), false, 'el bot nunca la movió: no hay nada que respetar');
});

test('una negociación derivada ANTES de este resguardo también queda protegida', async () => {
  // La marca en Redis solo existe para lo movido desde el despliegue. El problema de hoy está en lo
  // anterior: negociaciones derivadas hace días que el asesor ya tomó. Para eso se mira el registro
  // de derivaciones, que sí tiene historial.
  reset();
  const anteayer = Date.now() - 2 * 24 * 3600_000;
  ultimaDerivacion = anteayer; // el bot la derivó, pero sin marca en Redis
  deal.STAGE_ID = 'C73:UC_KY8NN7';
  deal.MOVED_BY_ID = String(ASESOR);
  deal.MOVED_TIME = new Date(anteayer + 3600_000).toISOString(); // el asesor la movió después

  assert.equal(await derivacionYaGestionada(5008, auth), true);
  assert.equal(await moverAEtapaDerivado(5008, auth), false);
  assert.equal(deal.STAGE_ID, 'C73:UC_KY8NN7');
});

test('si el asesor la movió ANTES de que el bot derivara, no cuenta como gestión de esa derivación', async () => {
  reset();
  const ayer = Date.now() - 24 * 3600_000;
  ultimaDerivacion = ayer;
  deal.MOVED_BY_ID = String(ASESOR);
  deal.MOVED_TIME = new Date(ayer - 3600_000).toISOString(); // una hora ANTES de derivar

  assert.equal(await derivacionYaGestionada(5009, auth), false);
});
