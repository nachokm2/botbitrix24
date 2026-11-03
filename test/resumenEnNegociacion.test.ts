import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// El asesor de Carver ve la tarjeta del embudo, no el chat: con BITRIX_UF_RESUMEN el evaluador de
// cada turno pide también un resumen de 2 o 3 frases y se escribe en la negociación, en la misma
// llamada que el score. Sin la variable, el evaluador y la escritura quedan como antes.
process.env.MARCA = 'carver';
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.BITRIX_UF_SCORE = 'UF_SCORE';
process.env.BITRIX_UF_RESUMEN = 'UF_RESUMEN';

const pedidos: any[] = [];
mock.module('../src/ai/client.ts', {
  namedExports: {
    anthropic: {
      messages: {
        create: async (args: any) => {
          pedidos.push(args);
          return {
            content: [
              {
                type: 'text',
                text: '{"score": 72, "intencion": "alta", "sentimiento": "positivo", "justificacion": "Pidió el valor.", "resumen": "Le interesa la Maestría en Psicología. Preguntó el valor y se le dio la cuota con beca. Quedó en confirmar el inicio."}',
              },
            ],
            usage: {},
          };
        },
      },
    },
    REASONER: 'claude-test-sonnet',
    CLASSIFIER: 'claude-test-haiku',
  },
});
const llamadas: { method: string; params: any }[] = [];
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: async () => ({}),
    callCrm: async (method: string, params: any) => void llamadas.push({ method, params }),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: [], total: 0, next: null }),
    callWebhook: async () => ({}),
  },
});

const { evaluarLead } = await import('../src/ai/scoring');
const { guardarEvaluacionCrm } = await import('../src/crm/crmWrite');
const auth = { domain: 'test.bitrix24.com', access_token: 'tok' } as any;

test('resumen: el evaluador lo pide y lo devuelve', async () => {
  const r = await evaluarLead([
    { role: 'user', content: 'Hola, ¿cuánto cuesta la Maestría en Psicología?' },
    { role: 'assistant', content: 'Con la beca queda en USD 195 al mes.' },
  ]);
  assert.match(pedidos.at(-1).system, /"resumen": "<2 o 3 frases>"/);
  assert.match(pedidos.at(-1).system, /sin teléfonos ni correos/);
  assert.match(r!.resumen!, /Maestría en Psicología/);
});

test('resumen: va a la negociación en la misma llamada que el score', async () => {
  llamadas.length = 0;
  await guardarEvaluacionCrm(
    { deal: 501 },
    { score: 72, intencion: 'alta', sentimiento: 'positivo', justificacion: 'x', resumen: 'Le interesa la MBA.' },
    auth,
    { writeNote: false },
  );
  const updates = llamadas.filter((l) => l.method === 'crm.deal.update');
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].params.fields, { UF_SCORE: 72, UF_RESUMEN: 'Le interesa la MBA.' });
});

test('resumen: si el evaluador no lo trae, no se borra el que había', async () => {
  llamadas.length = 0;
  await guardarEvaluacionCrm({ deal: 502 }, { score: 40, intencion: 'media', sentimiento: 'neutral', justificacion: 'x' }, auth, { writeNote: false });
  assert.deepEqual(llamadas.find((l) => l.method === 'crm.deal.update')!.params.fields, { UF_SCORE: 40 });
});
