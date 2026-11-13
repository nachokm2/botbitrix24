import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Negociación para quien llega al modo internacional sin una en el embudo (crm/negociacionInternacional.ts).
// Pedido del usuario del 13-11-2026 por el anuncio de Meta desde India: embudo Carver (73), etapa
// «Carver», responsable 4173.
process.env.MARCA = 'carver';
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.INTERNACIONAL_AVISAR_A = '4173';
process.env.INTERNACIONAL_PROGRAMA = 'Programa de Prueba';

const llamadas: Array<{ method: string; params: any }> = [];
let respuestas: Record<string, (p: any) => any> = {};
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callCrm: async (method: string, params: any) => {
      llamadas.push({ method, params });
      const r = respuestas[method];
      if (!r) throw new Error(`llamada inesperada a ${method}`);
      return r(params);
    },
    callBitrix: async () => ({}),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: [] }),
    callWebhook: async () => ({}),
  },
});
const auditorias: any[] = [];
mock.module('../src/obs/audit.ts', { namedExports: { audit: async (e: any) => void auditorias.push(e) } });

const { asegurarNegociacionInternacional, embudoDeEtapa } = await import('../src/crm/negociacionInternacional');
const { config } = await import('../src/config');
const auth = { domain: 'test.bitrix24.com', access_token: 'tok' } as any;
const tel = (t: string | null) => async () => t;
const metodo = (m: string) => llamadas.filter((l) => l.method === m);

beforeEach(() => {
  llamadas.length = 0;
  auditorias.length = 0;
  respuestas = {
    'crm.duplicate.findbycomm': () => ({}),
    'crm.contact.add': () => 501,
    'crm.contact.get': () => ({ NAME: 'Asha', LAST_NAME: 'Rao' }),
    'crm.deal.add': () => 9001,
  };
});

test('la etapa configurada por defecto es «Carver» del embudo 73, con el usuario como responsable', () => {
  assert.equal(config.internacionalEtapaNegociacion, 'C73:UC_173429');
  assert.equal(embudoDeEtapa(config.internacionalEtapaNegociacion), 73);
  assert.deepEqual(config.internacionalAvisarA, [4173]);
});

test('un número nuevo, sin nada en el CRM: crea el contacto y la negociación en el embudo 73', async () => {
  const r = await asegurarNegociacionInternacional({ dialogId: 'chat-nuevo', entidades: {}, telefono: tel('+919876543210'), auth });
  assert.deepEqual(r, { deal: 9001, contact: 501 });

  const contacto = metodo('crm.contact.add')[0].params.fields;
  assert.deepEqual(contacto.PHONE, [{ VALUE: '+919876543210', VALUE_TYPE: 'MOBILE' }]);
  assert.equal(contacto.ASSIGNED_BY_ID, 4173);

  const deal = metodo('crm.deal.add')[0].params.fields;
  assert.equal(deal.CATEGORY_ID, 73);
  assert.equal(deal.STAGE_ID, 'C73:UC_173429');
  assert.equal(deal.ASSIGNED_BY_ID, 4173);
  assert.equal(deal.CONTACT_ID, 501);
  assert.match(deal.TITLE, /^Programa de Prueba – /);
  if (config.ufPrograma) assert.equal(deal[config.ufPrograma], 'Programa de Prueba');
  assert.equal(auditorias[0].type, 'negociacion_internacional');

  // El mensaje siguiente usa la misma negociación, sin volver a Bitrix.
  llamadas.length = 0;
  const otra = await asegurarNegociacionInternacional({ dialogId: 'chat-nuevo', entidades: {}, telefono: tel('+919876543210'), auth });
  assert.deepEqual(otra, { deal: 9001, contact: 501 });
  assert.deepEqual(llamadas, []);
});

test('con solo un lead: usa el contacto que ya tiene ese teléfono y deja el lead enlazado', async () => {
  respuestas['crm.lead.get'] = () => ({ CONTACT_ID: '0', NAME: 'Asha' });
  respuestas['crm.duplicate.findbycomm'] = () => ({ CONTACT: [55] });
  const r = await asegurarNegociacionInternacional({ dialogId: 'chat-lead', entidades: { lead: 77 }, telefono: tel('+919811111111'), auth });
  assert.deepEqual(r, { lead: 77, deal: 9001, contact: 55 });
  assert.equal(metodo('crm.contact.add').length, 0, 'no duplica el contacto');
  const deal = metodo('crm.deal.add')[0].params.fields;
  assert.equal(deal.LEAD_ID, 77);
  assert.equal(deal.CONTACT_ID, 55);
  assert.match(deal.TITLE, /Asha/);
});

test('si ya tiene negociación en el embudo 73, no crea otra', async () => {
  respuestas['crm.deal.get'] = () => ({ CATEGORY_ID: '73' });
  const r = await asegurarNegociacionInternacional({ dialogId: 'chat-ya', entidades: { contact: 8, deal: 333 }, telefono: tel('+919822222222'), auth });
  assert.deepEqual(r, { contact: 8, deal: 333 });
  assert.equal(metodo('crm.deal.add').length, 0);
});

test('si su negociación está en otro embudo, crea la del 73 con el mismo contacto', async () => {
  respuestas['crm.deal.get'] = () => ({ CATEGORY_ID: '135' });
  const r = await asegurarNegociacionInternacional({ dialogId: 'chat-otro', entidades: { contact: 8, deal: 444 }, telefono: tel('+919833333333'), auth });
  assert.deepEqual(r, { contact: 8, deal: 9001 });
  assert.equal(metodo('crm.deal.add')[0].params.fields.CONTACT_ID, 8);
  assert.equal(auditorias[0].detail.otraNegociacion, 444);
});

test('si Bitrix falla, el bot sigue con lo que había, sin romperse', async () => {
  respuestas['crm.deal.add'] = () => {
    throw new Error('Bitrix no responde (simulado)');
  };
  const r = await asegurarNegociacionInternacional({ dialogId: 'chat-falla', entidades: { lead: 9 }, telefono: tel(null), auth });
  assert.deepEqual(r, { lead: 9 });
});

test('sin etapa configurada no se crea nada', async () => {
  const antes = config.internacionalEtapaNegociacion;
  (config as any).internacionalEtapaNegociacion = '';
  try {
    const r = await asegurarNegociacionInternacional({ dialogId: 'chat-sin-etapa', entidades: {}, telefono: tel('+919844444444'), auth });
    assert.deepEqual(r, {});
    assert.deepEqual(llamadas, []);
  } finally {
    (config as any).internacionalEtapaNegociacion = antes;
  }
});
