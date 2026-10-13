import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// El guardián dentro del motor (ai/agentLoop.ts): lo que se ENVÍA y lo que queda en el historial es
// el texto corregido, y un mensaje demasiado largo se condensa solo si conserva montos y enlaces.
process.env.MARCA = 'carver';
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.MAX_CARACTERES_RESPUESTA = '400';

mock.module('../src/obs/audit.ts', { namedExports: { audit: async () => {} } });
let principal = '';
let condensado = '';
let llamadasCondensar = 0;
mock.module('../src/ai/client.ts', {
  namedExports: {
    anthropic: {
      messages: {
        create: async (req: any) => {
          if (req.model === 'claude-test-haiku') {
            llamadasCondensar++;
            return { content: [{ type: 'text', text: condensado }], usage: {} };
          }
          return { content: [{ type: 'text', text: principal }], usage: {} };
        },
      },
    },
    REASONER: 'claude-test-sonnet',
    CLASSIFIER: 'claude-test-haiku',
  },
});

const { runAgentTurn } = await import('../src/ai/agentLoop');
const { getHistory } = await import('../src/ai/memory');
const { WHATSAPP_PROFILE } = await import('../src/core/channel');

const ctx = (id: string) =>
  ({ profile: WHATSAPP_PROFILE, auth: { domain: '', access_token: '' }, conversationId: id, crmEntities: {}, chatId: '1' }) as any;
const sinTools = async () => ({ ok: true });

test('lo enviado y lo guardado en el historial es el texto corregido (sin fee, sin markdown, sin enlace suelto)', async () => {
  principal =
    '**Precio:** contado USD 900. Además, la titulación cuesta USD 125 al finalizar. Brochure: https://uachile.bitrix24.es/doc/xyz ¿Le acomoda?';
  const r = await runAgentTurn(ctx('g-1'), '¿Cuánto cuesta la maestría en IA?', '', sinTools);
  assert.doesNotMatch(r, /\*\*|titulaci|USD 125|bitrix24/);
  assert.match(r, /contado USD 900/);
  const h = await getHistory('g-1');
  const guardado = JSON.stringify(h[h.length - 1].content);
  assert.doesNotMatch(guardado, /titulaci|bitrix24/, 'el modelo no "recuerda" haber dicho lo que no se envió');
});

test('un mensaje largo se condensa si la versión corta conserva montos y enlaces', async () => {
  principal = `Mensualidades: 12 cuotas de USD 150. Semestral: 2 pagos de USD 630. Contado: USD 900. ${'Detalle accesorio del programa. '.repeat(15)}¿Le acomoda alguna?`;
  condensado = 'Mensualidades: 12 cuotas de USD 150. Semestral: 2 pagos de USD 630. Contado: USD 900. ¿Le acomoda alguna?';
  const antes = llamadasCondensar;
  const r = await runAgentTurn(ctx('g-2'), '¿Cuánto cuesta?', '', sinTools);
  assert.equal(llamadasCondensar, antes + 1);
  assert.equal(r, condensado);
});

test('si la versión corta pierde un monto, se descarta y se envía la completa', async () => {
  principal = `Mensualidades: 12 cuotas de USD 150. Contado: USD 900. ${'Detalle accesorio. '.repeat(25)}¿Le acomoda?`;
  condensado = 'Mensualidades: 12 cuotas. ¿Le acomoda?'; // perdió USD 150 y USD 900
  const r = await runAgentTurn(ctx('g-3'), '¿Cuánto cuesta?', '', sinTools);
  assert.match(r, /USD 150/);
  assert.match(r, /USD 900/);
});

test('un enlace devuelto por una herramienta en el turno sí se conserva', async () => {
  principal = 'Le comparto el brochure:\nhttps://uachile.bitrix24.es/doc/verificado';
  let paso = 0;
  const mod = await import('../src/ai/client');
  const original = (mod as any).anthropic.messages.create;
  (mod as any).anthropic.messages.create = async (req: any) => {
    paso++;
    if (paso === 1) return { content: [{ type: 'tool_use', id: 't1', name: 'obtener_brochure', input: { programa: 'x' } }], usage: {} };
    return original(req);
  };
  try {
    const r = await runAgentTurn(ctx('g-4'), 'Brochure', '', async () => ({ ok: true, url: 'https://uachile.bitrix24.es/doc/verificado' }));
    assert.match(r, /https:\/\/uachile\.bitrix24\.es\/doc\/verificado/);
  } finally {
    (mod as any).anthropic.messages.create = original;
  }
});

test('si el registro en el CRM falló en el turno, la respuesta no dice que quedó registrado', async () => {
  principal = 'Gracias, Carla. Su correo quedará registrado para darle seguimiento. ¿Le cuento el programa?';
  let paso = 0;
  const mod = await import('../src/ai/client');
  const original = (mod as any).anthropic.messages.create;
  (mod as any).anthropic.messages.create = async (req: any) => {
    paso++;
    if (paso === 1) return { content: [{ type: 'tool_use', id: 'r1', name: 'registrar_interes_crm', input: { email: 'c@x.com' } }], usage: {} };
    return original(req);
  };
  try {
    const r = await runAgentTurn(ctx('g-5'), 'Soy Carla, c@x.com', '', async () => ({ ok: false, error: 'BITRIX_NO_DISPONIBLE' }));
    assert.doesNotMatch(r, /registrad/);
    assert.match(r, /¿Le cuento el programa\?/);
  } finally {
    (mod as any).anthropic.messages.create = original;
  }
});
