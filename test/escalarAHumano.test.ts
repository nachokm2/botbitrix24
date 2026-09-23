import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Bug real de producción: cuando el cliente PEDÍA hablar con un asesor, no recibía ninguna respuesta.
// escalar_a_humano entregaba la sesión de Open Lines al operador ANTES de que el bot alcanzara a
// enviar su mensaje; al hacerlo, Bitrix le quita el permiso de escribir en ese chat y rechazaba la
// respuesta con "CANCELED No puede enviar mensajes al chat especificado". Pasaba en 3 de 3
// escalamientos explícitos, mientras que el automático por score (ai/scoring.ts, que manda el
// mensaje ANTES de transferir) funcionó 7 de 7. Acá se fija el orden correcto.
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

const llamadas: { method: string; params: any }[] = [];
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: async (method: string, params: any) => {
      llamadas.push({ method, params });
      return {};
    },
    callCrm: async (method: string, params: any) => {
      llamadas.push({ method, params });
      return {};
    },
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: {}, total: 0 }),
    callWebhook: async () => ({}),
  },
});

const asignaciones: unknown[] = [];
mock.module('../src/crm/asignacionAsesores.ts', {
  namedExports: {
    asignarAsesorPorTurno: async (entities: unknown) => {
      asignaciones.push(entities);
      return true;
    },
    programaCoincide: () => false,
  },
});

const { executeTool } = await import('../src/ai/toolRunner');
const { WHATSAPP_PROFILE } = await import('../src/core/channel');

const nuevoCtx = () =>
  ({
    auth: { domain: 'test.bitrix24.com', access_token: 'tok' },
    conversationId: 'chat-esc-1',
    chatId: '1456309',
    botId: 1,
    crmEntities: {},
    crmEntity: null,
    profile: WHATSAPP_PROFILE,
  }) as any;

test('escalar_a_humano: NO entrega la sesión al operador dentro de la tool (si lo hiciera, el cliente se queda sin respuesta)', async () => {
  llamadas.length = 0;
  const ctx = nuevoCtx();

  const r = await executeTool('escalar_a_humano', { motivo: 'el cliente pide un asesor' }, ctx);

  assert.equal(r.ok, true);
  assert.equal(r.escalado, true);
  assert.ok(
    !llamadas.some((l) => l.method === 'imopenlines.bot.session.operator'),
    'la transferencia debe quedar para DESPUÉS de enviar la respuesta, no ejecutarse acá',
  );
});

test('escalar_a_humano: marca la transferencia en el contexto, para que el adaptador la haga al final del turno', async () => {
  const ctx = nuevoCtx();
  await executeTool('escalar_a_humano', { motivo: 'quiere hablar con alguien' }, ctx);
  assert.equal(ctx.transferirAOperador, true);
});

test('escalar_a_humano: sin chatId (Web Chat, Instagram, Messenger) no hay sesión de Open Lines que transferir', async () => {
  const ctx = nuevoCtx();
  ctx.chatId = undefined;
  await executeTool('escalar_a_humano', { motivo: 'consulta desde la web' }, ctx);
  assert.notEqual(ctx.transferirAOperador, true, 'esos canales no tienen sesión de Open Lines');
});

test('escalar_a_humano: igual asigna al asesor por turno (eso nunca dependió del orden)', async () => {
  asignaciones.length = 0;
  await executeTool('escalar_a_humano', { motivo: 'pide asesor' }, nuevoCtx());
  assert.equal(asignaciones.length, 1);
});
