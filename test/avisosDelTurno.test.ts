import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Después de cada turno de Carver (ai/agentLoop.ts:avisosDelTurno): si el bot promete volver con algo
// sin haber derivado, o el cliente quiere pagar, el responsable recibe un aviso. Casos reales del
// 30 y 31 de octubre de 2026: una promesa de "confirmaré la acreditación" que nadie cumplió, y un
// cliente que preguntó tres veces cuánto pagaba al contado sin que su asesor se enterara.
process.env.MARCA = 'carver';
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

mock.module('../src/obs/audit.ts', { namedExports: { audit: async () => {} } });
const avisos: any[] = [];
mock.module('../src/crm/avisoAsesor.ts', {
  namedExports: {
    avisarAlResponsable: async (a: any) => {
      avisos.push(a);
      return { avisado: true, destino: 1 };
    },
  },
});
/** Respuestas del modelo, en orden: cada llamada saca la siguiente. */
let guion: any[] = [];
mock.module('../src/ai/client.ts', {
  namedExports: {
    anthropic: { messages: { create: async () => guion.shift() ?? { content: [{ type: 'text', text: 'ok' }], usage: {} } } },
    REASONER: 'claude-test-sonnet',
    CLASSIFIER: 'claude-test-haiku',
  },
});

const { runAgentTurn } = await import('../src/ai/agentLoop');
const { WHATSAPP_PROFILE } = await import('../src/core/channel');

const ctx = (id: string) =>
  ({ profile: WHATSAPP_PROFILE, auth: { domain: 'x', access_token: '' }, conversationId: id, crmEntities: { deal: 3704995 }, chatId: '1561991' }) as any;
const texto = (t: string) => ({ content: [{ type: 'text', text: t }], usage: {} });
const herramienta = (name: string) => ({ content: [{ type: 'tool_use', id: `t-${name}`, name, input: {} }], usage: {} });
const esperar = async (cond: () => boolean) => {
  for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
};

test('promete confirmar algo sin derivar: el responsable recibe el pendiente, con tarea', async () => {
  avisos.length = 0;
  guion = [texto('Sobre la acreditación, lo confirmo con el área académica y le respondo el lunes en la mañana.')];
  await runAgentTurn(ctx('av-1'), '¿Tienen acreditación regional?', '', async () => ({ ok: true }));
  await esperar(() => avisos.length > 0);
  assert.equal(avisos.length, 1);
  assert.equal(avisos[0].tipo, 'promesa');
  assert.equal(avisos[0].dealId, 3704995);
  assert.equal(avisos[0].tarea, true);
  assert.match(avisos[0].detalle, /lo confirmo con el área académica/);
  assert.match(avisos[0].detalle, /acreditación regional/);
});

test('si en el mismo turno derivó, no hay aviso extra: la derivación ya avisa', async () => {
  avisos.length = 0;
  guion = [herramienta('escalar_a_humano'), texto('Lo confirmo con el área académica y le respondo el lunes en la mañana.')];
  await runAgentTurn(ctx('av-2'), '¿Tienen acreditación regional?', '', async () => ({ ok: true }));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(avisos.length, 0);
});

test('el cliente quiere pagar: aviso de pago aunque el bot todavía no le haya dado el enlace', async () => {
  avisos.length = 0;
  guion = [texto('Al contado son USD 900, sin matrícula. ¿Le genero el enlace?')];
  await runAgentTurn(ctx('av-3'), 'Si pago todo de contado porque valor me sale ??', '', async () => ({ ok: true }));
  await esperar(() => avisos.length > 0);
  assert.deepEqual(avisos.map((a) => a.tipo), ['pago']);
});

test('una respuesta normal no avisa a nadie', async () => {
  avisos.length = 0;
  guion = [texto('La maestría dura 12 meses y es 100% en línea con clases en vivo. ¿Le cuento los valores?')];
  await runAgentTurn(ctx('av-4'), 'Más información', '', async () => ({ ok: true }));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(avisos.length, 0);
});
