import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// registrar_documento_identidad: sube al Deal la foto de cédula que el cliente envió EN ESE MISMO
// turno (visión) — campo real de Bitrix "Cedula de identidad CL" (UF_CRM_1709318371), confirmado
// vacío en un deal real antes de conectarlo. Los tool-calls no llevan binarios: el turno guarda la
// imagen en ctx.pendingImage (ver routes/botEvents.ts) y esta tool sube esos bytes.
process.env.REDIS_URL = '';
process.env.NODE_ENV = 'test';
process.env.BITRIX_UF_CEDULA = 'UF_CRM_TEST_CEDULA';

type Call = { method: string; params: any };
const calls: Call[] = [];
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: async (method: string, params: any) => {
      calls.push({ method, params });
      return {};
    },
    callCrm: async (method: string, params: any) => {
      calls.push({ method, params });
      return {};
    },
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: {} }),
    callWebhook: async () => ({}),
  },
});

const { executeTool } = await import('../src/ai/toolRunner');
const { WHATSAPP_PROFILE } = await import('../src/core/channel');

const baseCtx = {
  auth: { domain: '', access_token: '' },
  conversationId: 't-1',
  botId: 1,
  crmEntities: { deal: 777 },
  crmEntity: { type: 'deal', id: 777 },
  profile: WHATSAPP_PROFILE,
} as any;

test('registrar_documento_identidad: sube la imagen del turno al campo real de Bitrix', async () => {
  calls.length = 0;
  const r = await executeTool(
    'registrar_documento_identidad',
    {},
    { ...baseCtx, pendingImage: { base64: 'ZmFrZS1qcGc=', mediaType: 'image/jpeg' } },
  );

  assert.equal(r.ok, true);
  const upd = calls.find((c) => c.method === 'crm.deal.update' && c.params.id === 777);
  assert.ok(upd, 'actualiza el deal');
  const campo = upd!.params.fields.UF_CRM_TEST_CEDULA;
  assert.ok(campo, 'setea el campo de cédula');
  assert.equal(campo.fileData[0], 'cedula-deal-777.jpg');
  assert.equal(campo.fileData[1], 'ZmFrZS1qcGc=', 'sube los bytes reales de la imagen del turno, no un placeholder');
});

test('registrar_documento_identidad: elige extensión .png cuando el mediaType es image/png', async () => {
  calls.length = 0;
  await executeTool('registrar_documento_identidad', {}, { ...baseCtx, pendingImage: { base64: 'ZmFrZS1wbmc=', mediaType: 'image/png' } });

  const upd = calls.find((c) => c.method === 'crm.deal.update');
  assert.equal(upd!.params.fields.UF_CRM_TEST_CEDULA.fileData[0], 'cedula-deal-777.png');
});
