import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// seguimiento.ts: seguimiento en 2 etapas si el cliente queda en silencio tras la última respuesta
// del bot — 1) recordatorio (IA) a SEGUIMIENTO_HORAS, 2) si SIGUE sin responder, derivación al
// asesor por turno a SEGUIMIENTO_TRANSFERENCIA_HORAS (NO urgente: no silencia al bot). Caso real que
// motivó el horario permitido: el recordatorio se disparó a las 2am (respuesta a las 10:59pm + 3h).
process.env.NODE_ENV = 'test';
process.env.BITRIX_UF_PROGRAMA = 'UF_CRM_PROGRAMA_TEST';

type Call = { method: string; params: any };
const calls: Call[] = [];
let dealProgramas: Record<number, string> = {};

mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: async (method: string, params: any) => record(method, params),
    callCrm: async (method: string, params: any) => record(method, params),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: {} }),
    callWebhook: async () => ({}),
  },
});
async function record(method: string, params: any) {
  calls.push({ method, params });
  if (method === 'crm.deal.get') return { UF_CRM_PROGRAMA_TEST: dealProgramas[params.id] ?? '', TITLE: 'x' };
  if (method === 'tasks.task.add') return { task: { id: 999 } };
  return {};
}

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

// Fake Redis: ZSETs en memoria (zadd/zrem/zrangebyscore) para las 2 colas de vencimiento, e incr
// para el contador de turno de asignacionAsesores.ts. getJson/setJson/once replican store/kv.ts
// (Map en memoria), SIN depender de Redis de verdad — mismo enfoque que asignacionAsesores.test.ts.
const zsets = new Map<string, Map<string, number>>();
const contadores = new Map<string, number>();
const usados = new Set<string>();
const kvStore = new Map<string, string>();

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
  zrangebyscore: async (key: string, _min: string, max: number) => {
    const z = zsets.get(key);
    if (!z) return [];
    return [...z.entries()].filter(([, score]) => score <= max).sort((a, b) => a[1] - b[1]).map(([m]) => m);
  },
  incr: async (key: string) => {
    const n = (contadores.get(key) ?? 0) + 1;
    contadores.set(key, n);
    return n;
  },
  hincrby: async () => 1, // usado por obs/metrics.ts:inc() — no relevante para estas pruebas
};

mock.module('../src/store/kv.ts', {
  namedExports: {
    getRedisClient: () => fakeRedis,
    getJson: async (key: string) => (kvStore.has(key) ? JSON.parse(kvStore.get(key)!) : null),
    setJson: async (key: string, val: unknown) => {
      kvStore.set(key, JSON.stringify(val));
    },
    kvDel: async (key: string) => {
      kvStore.delete(key);
    },
    once: async (key: string) => {
      if (usados.has(key)) return false;
      usados.add(key);
      return true;
    },
  },
});

const {
  horaEnChile,
  proximoHorarioPermitido,
  programarSeguimiento,
  barrerTransferenciasVencidas,
} = await import('../src/ai/seguimiento');
const { config } = await import('../src/config');

/** Busca, a partir de `desde`, el próximo instante cuya hora Chile sea exactamente `hora`. */
function buscarInstanteConHora(desde: Date, hora: number): Date {
  let t = desde;
  for (let i = 0; i < 48; i++) {
    if (horaEnChile(t) === hora) return t;
    t = new Date(t.getTime() + 3600_000);
  }
  throw new Error(`no se encontró un instante con hora ${hora}`);
}

test('proximoHorarioPermitido: un plazo de madrugada se corre al inicio de la ventana permitida', () => {
  const madrugada = buscarInstanteConHora(new Date(), 2); // ej. las 2am, el caso real reportado
  const resultado = proximoHorarioPermitido(madrugada);
  assert.equal(horaEnChile(resultado), config.seguimientoHoraInicio, 'se corre exactamente al inicio de la ventana');
  assert.ok(resultado.getTime() >= madrugada.getTime(), 'nunca se mueve hacia atrás en el tiempo');
});

test('proximoHorarioPermitido: un plazo ya dentro de la ventana permitida no se toca', () => {
  const mediodia = buscarInstanteConHora(new Date(), 14); // dentro de [9,21) por defecto
  const resultado = proximoHorarioPermitido(mediodia);
  assert.equal(resultado.getTime(), mediodia.getTime(), 'no reprograma un plazo que ya cae en horario permitido');
});

test('proximoHorarioPermitido: un plazo de noche (después del cierre) se corre al día siguiente', () => {
  const noche = buscarInstanteConHora(new Date(), 23); // después de las 21h por defecto
  const resultado = proximoHorarioPermitido(noche);
  assert.equal(horaEnChile(resultado), config.seguimientoHoraInicio);
  assert.ok(resultado.getTime() > noche.getTime(), 'lo corre hacia adelante, al inicio de la ventana del día siguiente');
});

test('programarSeguimiento: agenda recordatorio y transferencia, con la transferencia más tarde', async () => {
  await programarSeguimiento('dlg-orden', { deal: 301 });
  const due = zsets.get('seguimiento:due')!.get('dlg-orden')!;
  const transferencia = zsets.get('seguimiento:transferencia:due')!.get('dlg-orden')!;
  assert.ok(transferencia > due, 'la transferencia vence después que el recordatorio');
});

test('barrerTransferenciasVencidas: cliente sigue en silencio tras el recordatorio → deriva al asesor SIN transferencia urgente', async () => {
  calls.length = 0;
  dealProgramas = { 302: 'Diplomado en Inteligencia Artificial' };

  await programarSeguimiento('dlg-silencio', { deal: 302 });
  // Simula que venció el plazo de transferencia (independiente del reloj real): mueve el vencimiento al pasado.
  zsets.get('seguimiento:transferencia:due')!.set('dlg-silencio', Date.now() - 1000);

  await barrerTransferenciasVencidas();

  const upd = calls.find((c) => c.method === 'crm.deal.update' && c.params.id === 302);
  assert.ok(upd, 'asigna el deal a un asesor por turno');
  const tarea = calls.find((c) => c.method === 'tasks.task.add');
  assert.ok(tarea, 'crea una tarea para el asesor');
  assert.match(tarea!.params.fields.TITLE, /Contacto temprano/i, 'la tarea usa el texto NO urgente (motivo="silencio")');
  assert.ok(!calls.find((c) => c.method === 'imopenlines.bot.session.operator'), 'NO hace un handoff urgente de la sesión de Open Lines');

  // Ya se consumió: una segunda pasada del barrido no vuelve a asignar ni duplicar la tarea.
  assert.equal(zsets.get('seguimiento:transferencia:due')!.has('dlg-silencio'), false, 'el vencimiento se reclama (ZREM) al procesarlo');
});

test('barrerTransferenciasVencidas: no hace nada si el plazo todavía no vence', async () => {
  calls.length = 0;
  dealProgramas = { 303: 'Diplomado en Inteligencia Artificial' };
  await programarSeguimiento('dlg-futuro', { deal: 303 }); // vencimiento queda en el futuro (>= horas configuradas)

  await barrerTransferenciasVencidas();

  assert.ok(!calls.find((c) => c.method === 'crm.deal.update'), 'no toca un deal cuyo plazo aún no venció');
});
