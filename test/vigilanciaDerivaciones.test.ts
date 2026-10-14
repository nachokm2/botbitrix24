import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// vigilanciaDerivaciones.ts: avisa cuando el bot deriva una negociación y nadie la trabaja.
// Hallazgo que lo motivó: de 38 derivaciones del piloto, 4 las tomó una persona; a las otras las
// barrió el robot #45 a Remarketing sin que nadie se enterara.
process.env.NODE_ENV = 'test';

type Call = { method: string; params: any };
const calls: Call[] = [];

// Estado de la negociación que ve el barrido; cada prueba lo ajusta.
let deal: Record<string, any> = {};
let fallarCrm = false;

mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: async (method: string, params: any) => {
      calls.push({ method, params });
      return {};
    },
    callCrm: async (method: string, params: any) => {
      calls.push({ method, params });
      if (fallarCrm) throw new Error('expired token');
      return method === 'crm.deal.get' ? deal : {};
    },
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: {} }),
    callWebhook: async () => ({}),
  },
});

type AuditCall = { type: string; dialogId?: string; crmEntity?: string; detail?: any };
const auditCalls: AuditCall[] = [];
mock.module('../src/obs/audit.ts', {
  namedExports: {
    audit: async (e: AuditCall) => {
      auditCalls.push(e);
    },
  },
});

let urgente = false;
mock.module('../src/crm/urgencia.ts', { namedExports: { esUrgente: async () => urgente } });

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

let huboOperador = false;
mock.module('../src/store/db.ts', {
  namedExports: {
    dbHuboOperadorDespuesDe: async () => huboOperador,
    dbInsertAudit: async () => {},
  },
});

const zsets = new Map<string, Map<string, number>>();
const claves = new Map<string, string>();
const fakeRedis = {
  zadd: async (key: string, score: number, member: string) => {
    if (!zsets.has(key)) zsets.set(key, new Map());
    zsets.get(key)!.set(member, score);
    return 1;
  },
  zrem: async (key: string, member: string) => {
    const z = zsets.get(key);
    if (!z || !z.has(member)) return 0;
    z.delete(member);
    return 1;
  },
  zscore: async (key: string, member: string) => {
    const s = zsets.get(key)?.get(member);
    return s === undefined ? null : String(s);
  },
  zrangebyscore: async (key: string, _min: string, max: number) => {
    const z = zsets.get(key);
    if (!z) return [];
    return [...z.entries()]
      .filter(([, s]) => s <= max)
      .sort((a, b) => a[1] - b[1])
      .map(([m]) => m);
  },
  get: async (key: string) => claves.get(key) ?? null,
  set: async (key: string, val: string) => {
    claves.set(key, val);
    return 'OK';
  },
  hincrby: async () => 1,
};
mock.module('../src/store/kv.ts', {
  namedExports: {
    getRedisClient: () => fakeRedis,
    getJson: async () => null,
    setJson: async () => {},
    kvDel: async () => {},
    once: async () => true,
  },
});

const { vigilarDerivacion, barrerVigilanciaDerivaciones } = await import('../src/crm/vigilanciaDerivaciones');
const { config } = await import('../src/config');

const VIGILANCIA_KEY = 'derivacion:vigilancia';

function reset() {
  calls.length = 0;
  auditCalls.length = 0;
  zsets.clear();
  claves.clear();
  huboOperador = false;
  fallarCrm = false;
  deal = { ASSIGNED_BY_ID: 1313, MOVED_BY_ID: 0, MOVED_TIME: null };
  config.derivacionAlertaHoras = 4;
  config.derivacionAlertaSupervisorHoras = 24;
  config.derivacionSupervisorId = 0;
  config.derivacionAlertaUrgenteHoras = 1;
  urgente = false;
}

/** Adelanta el reloj: vence la entrada y envejece la fecha de derivación, que es lo que mira el barrido. */
function vencer(dealId: number, horasAtras = 5) {
  zsets.get(VIGILANCIA_KEY)!.set(String(dealId), Date.now() - 1000);
  const datos = JSON.parse(claves.get(`derivacion:datos:${dealId}`)!);
  datos.derivadoEn = Date.now() - horasAtras * 3600_000;
  claves.set(`derivacion:datos:${dealId}`, JSON.stringify(datos));
}

const avisos = () => calls.filter((c) => c.method === 'im.notify.personal.add');

test('programa la vigilancia y no reinicia el reloj si se deriva dos veces', async () => {
  reset();
  await vigilarDerivacion(500, 'chat1');
  const primero = zsets.get(VIGILANCIA_KEY)!.get('500');
  assert.ok(primero && primero > Date.now());
  await new Promise((r) => setTimeout(r, 5));
  await vigilarDerivacion(500, 'chat1');
  assert.equal(zsets.get(VIGILANCIA_KEY)!.get('500'), primero, 'una segunda derivación no debe dar más plazo');
});

test('no avisa antes de que venza el plazo', async () => {
  reset();
  await vigilarDerivacion(501, 'chat1');
  await barrerVigilanciaDerivaciones();
  assert.equal(avisos().length, 0);
  assert.ok(zsets.get(VIGILANCIA_KEY)!.has('501'), 'sigue en la cola');
});

test('vencido y sin tomar: avisa al responsable de la negociación', async () => {
  reset();
  await vigilarDerivacion(502, 'chat1');
  vencer(502);
  await barrerVigilanciaDerivaciones();

  assert.equal(avisos().length, 1);
  assert.equal(avisos()[0].params.USER_ID, 1313);
  assert.match(avisos()[0].params.MESSAGE, /deal\/details\/502/);
  const a = auditCalls.find((x) => x.type === 'derivacion_sin_tomar');
  assert.ok(a);
  assert.equal(a.crmEntity, 'deal#502');
  assert.equal(a.detail.avisadoA, 1313);
  assert.equal(a.detail.etapa, 1);
});

test('si un asesor escribió en el chat, no molesta y deja de vigilar', async () => {
  reset();
  huboOperador = true;
  await vigilarDerivacion(503, 'chat1');
  vencer(503);
  await barrerVigilanciaDerivaciones();

  assert.equal(avisos().length, 0);
  assert.ok(!zsets.get(VIGILANCIA_KEY)!.has('503'), 'un caso atendido sale de la cola');
});

test('si una persona movió la etapa después de derivar, cuenta como atendido', async () => {
  reset();
  deal = { ASSIGNED_BY_ID: 1313, MOVED_BY_ID: 99, MOVED_TIME: new Date().toISOString() };
  await vigilarDerivacion(504, 'chat1');
  vencer(504);
  await barrerVigilanciaDerivaciones();
  assert.equal(avisos().length, 0);
});

test('el barrido del robot a Remarketing NO cuenta como atendido', async () => {
  reset();
  deal = { ASSIGNED_BY_ID: 1313, MOVED_BY_ID: config.usuariosAutomaticos[0], MOVED_TIME: new Date().toISOString() };
  await vigilarDerivacion(505, 'chat1');
  vencer(505);
  await barrerVigilanciaDerivaciones();
  assert.equal(avisos().length, 1, 'el robot movió la etapa, pero nadie trabajó el caso');
});

test('un movimiento anterior a la derivación no cuenta', async () => {
  reset();
  deal = { ASSIGNED_BY_ID: 1313, MOVED_BY_ID: 99, MOVED_TIME: new Date(Date.now() - 10 * 3600_000).toISOString() };
  await vigilarDerivacion(506, 'chat1');
  vencer(506);
  await barrerVigilanciaDerivaciones();
  assert.equal(avisos().length, 1);
});

test('con supervisor configurado escala una vez y después deja de insistir', async () => {
  reset();
  config.derivacionSupervisorId = 777;
  await vigilarDerivacion(507, 'chat1');
  vencer(507);
  await barrerVigilanciaDerivaciones();

  assert.equal(avisos()[0].params.USER_ID, 1313, 'primer aviso: al responsable');
  assert.ok(zsets.get(VIGILANCIA_KEY)!.has('507'), 'queda reprogramado para el supervisor');

  vencer(507, 25);
  await barrerVigilanciaDerivaciones();
  assert.equal(avisos().length, 2);
  assert.equal(avisos()[1].params.USER_ID, 777, 'segundo aviso: al supervisor');
  assert.ok(!zsets.get(VIGILANCIA_KEY)!.has('507'), 'no hay tercer aviso');
});

test('sin supervisor configurado no hay segundo aviso', async () => {
  reset();
  await vigilarDerivacion(508, 'chat1');
  vencer(508);
  await barrerVigilanciaDerivaciones();
  assert.equal(avisos().length, 1);
  assert.ok(!zsets.get(VIGILANCIA_KEY)!.has('508'));
});

test('si no se puede leer la negociación, no avisa: ante la duda no se molesta a nadie', async () => {
  reset();
  await vigilarDerivacion(509, 'chat1');
  vencer(509);
  fallarCrm = true;
  await barrerVigilanciaDerivaciones();
  assert.equal(avisos().length, 0);
  assert.ok(zsets.get(VIGILANCIA_KEY)!.has('509'), 'vuelve a la cola: una caída no debe borrar la vigilancia');

  // Cuando Bitrix vuelve, el caso se evalúa igual que siempre.
  fallarCrm = false;
  vencer(509);
  await barrerVigilanciaDerivaciones();
  assert.equal(avisos().length, 1);
});

test('un caso urgente se vigila con un plazo más corto', async () => {
  // El escalamiento por puntaje lo dispara alguien con interés claro que ya dejó sus datos: a las
  // cuatro horas el momento ya pasó.
  reset();
  urgente = true;
  await vigilarDerivacion(600, 'chat-u');
  const vence = zsets.get(VIGILANCIA_KEY)!.get('600')!;
  const horas = (vence - Date.now()) / 3600_000;
  assert.ok(horas > 0 && horas <= 1.05, `venció en ${horas} h, se esperaba ~1`);
});

test('uno normal conserva el plazo de siempre', async () => {
  reset();
  await vigilarDerivacion(601, 'chat-n');
  const horas = (zsets.get(VIGILANCIA_KEY)!.get('601')! - Date.now()) / 3600_000;
  assert.ok(horas > 3 && horas <= 4.05, `venció en ${horas} h, se esperaba ~4`);
});

test('el aviso de un urgente dice por qué lo es', async () => {
  reset();
  urgente = true;
  await vigilarDerivacion(602, 'chat-u2');
  vencer(602, 2);
  await barrerVigilanciaDerivaciones();
  assert.equal(avisos().length, 1);
  assert.match(avisos()[0].params.MESSAGE, /puntaje alto/);
});

test('si el plazo urgente fuera mayor que el normal, manda el normal', async () => {
  // Una configuración incoherente no debe ALARGAR el plazo de un caso urgente.
  reset();
  urgente = true;
  config.derivacionAlertaUrgenteHoras = 99;
  await vigilarDerivacion(603, 'chat-u3');
  const horas = (zsets.get(VIGILANCIA_KEY)!.get('603')! - Date.now()) / 3600_000;
  assert.ok(horas <= 4.05, `venció en ${horas} h`);
});
