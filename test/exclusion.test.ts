import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Lista de exclusión. Responder a quien te escribe no necesita permiso; escribir primero sí, y la
// contrapartida es respetar al que dice que no. Importa además porque quien no puede salir bloquea
// o reporta, y eso degrada la calificación del número — el MISMO por el que el bot conversa con
// todos los demás.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

const claves = new Map<string, string>();
const usados = new Set<string>();
const fakeRedis = {
  get: async (k: string) => claves.get(k) ?? null,
  set: async (k: string, v: string) => {
    claves.set(k, v);
    return 'OK';
  },
  hincrby: async () => 1,
};
mock.module('../src/store/kv.ts', {
  namedExports: {
    getRedisClient: () => fakeRedis,
    once: async (k: string) => {
      if (usados.has(k)) return false;
      usados.add(k);
      return true;
    },
    getJson: async () => null,
    getJsonOrThrow: async () => null,
    setJson: async () => {},
    kvDel: async () => {},
  },
});

const auditCalls: any[] = [];
mock.module('../src/obs/audit.ts', { namedExports: { audit: async (e: any) => { auditCalls.push(e); } } });

const { pideNoMolestar, excluir, estaExcluido } = await import('../src/crm/exclusion');

test('reconoce las formas reales de pedir la baja', () => {
  for (const frase of [
    'no me escriban más por favor',
    'No me vuelvan a contactar',
    'quiero darme de baja',
    'desuscribirme de esta lista',
    'quítenme de la lista',
    'dejen de molestar',
    'STOP',
    'no insistan',
  ]) {
    assert.equal(pideNoMolestar(frase), true, `no detectó: ${frase}`);
  }
});

test('NO confunde descartar un programa con pedir la baja', () => {
  // Esto es lo que más caro sale: tratar un "no me interesa este programa" como baja deja fuera a
  // alguien que solo estaba descartando una opción.
  for (const frase of [
    'no',
    'no me interesa ese programa',
    'no tengo el presupuesto ahora',
    'no sé si me conviene la maestría',
    'no puedo hablar ahora, te escribo luego',
    'no gracias, prefiero la licenciatura',
  ]) {
    assert.equal(pideNoMolestar(frase), false, `falso positivo con: ${frase}`);
  }
});

test('un texto largo no se interpreta como baja', () => {
  const largo = 'hola '.repeat(80) + 'no me escriban mas';
  assert.equal(pideNoMolestar(largo), false);
});

test('la baja bloquea por teléfono y por contacto', async () => {
  claves.clear();
  await excluir({ telefono: '+56912345678', contactId: 10, motivo: 'pedido_del_cliente' });
  assert.equal(await estaExcluido({ telefono: '+56912345678' }), true);
  assert.equal(await estaExcluido({ contactId: 10 }), true);
  assert.equal(await estaExcluido({ telefono: '+56999999999', contactId: 99 }), false);
});

test('la misma persona con otra ficha sigue excluida por su teléfono', async () => {
  claves.clear();
  await excluir({ telefono: '+56911112222', contactId: 10, motivo: 'pedido_del_cliente' });
  // Aparece de nuevo en el CRM con otro contactId pero el mismo número.
  assert.equal(await estaExcluido({ telefono: '+56911112222', contactId: 777 }), true);
});

test('registrar la misma baja dos veces no duplica la auditoría', async () => {
  claves.clear();
  auditCalls.length = 0;
  usados.clear();
  await excluir({ telefono: '+56933334444', motivo: 'pedido_del_cliente' });
  await excluir({ telefono: '+56933334444', motivo: 'pedido_del_cliente' });
  assert.equal(auditCalls.filter((a) => a.type === 'exclusion').length, 1);
});

test('sin Redis responde que SÍ está excluido: ante la duda no se escribe', async () => {
  const { getRedisClient } = await import('../src/store/kv');
  const original = getRedisClient;
  // Se simula la ausencia de Redis devolviendo null desde el mock.
  (fakeRedis as any).get = async () => {
    throw new Error('sin conexión');
  };
  assert.equal(await estaExcluido({ telefono: '+56900000000' }), true, 'es más barato no escribir que escribirle a quien dijo que no');
  (fakeRedis as any).get = async (k: string) => claves.get(k) ?? null;
  assert.ok(original);
});
