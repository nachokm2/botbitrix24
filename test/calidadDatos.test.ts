import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Calidad de los datos del CRM. Antes un teléfono mal cargado solo significaba que un asesor no
// podía llamar; ahora cada registro defectuoso cuesta dinero —se paga por mensaje— y ensucia la
// medición. En la primera muestra real de Carver, 3 de cada 200 tenían el país equivocado.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.BITRIX_UF_PROGRAMA = 'UF_PROG';

let deals: any[] = [];
let contactos: any[] = [];
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callCrm: async (method: string, params: any) => {
      if (method === 'crm.deal.list') return params.start ? [] : deals;
      if (method === 'crm.contact.list') return contactos.filter((c) => params.filter['@ID'].includes(Number(c.ID)));
      return [];
    },
    callBitrix: async () => ({}),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: {} }),
    callWebhook: async () => ({}),
  },
});

mock.module('../src/store/db.ts', {
  namedExports: {
    dbDialogosConDeal: async () => [],
    dbDialogosPorTextoPrograma: async () => [],
    dbInsertAudit: async () => {},
    dbHuboOperadorDespuesDe: async () => false,
  },
});

const { informeCalidadDatos } = await import('../src/crm/calidadDatos');
const { config } = await import('../src/config');

const auth = { domain: 'test.bitrix24.com', access_token: 'tok' } as any;

test('cuenta cada tipo de defecto por separado', async () => {
  config.primerContactoPaises = ['+56', '+57'];
  config.primerContactoCategorias = [];
  deals = [
    { ID: '1', CONTACT_ID: '10', TITLE: 'A', UF_PROG: 'Maestría' },       // sano
    { ID: '2', CONTACT_ID: '20', TITLE: 'B', UF_PROG: '' },               // sin programa
    { ID: '3', CONTACT_ID: '30', TITLE: 'C', UF_PROG: 'Licenciatura' },   // teléfono de país no atendido
    { ID: '4', CONTACT_ID: '', TITLE: 'D', UF_PROG: 'Maestría' },         // sin contacto
    { ID: '5', CONTACT_ID: '50', TITLE: 'E', UF_PROG: 'Maestría' },       // sin nombre y sin teléfono
  ];
  contactos = [
    { ID: '10', NAME: 'Camila', PHONE: [{ VALUE: '+56912345678' }] },
    { ID: '20', NAME: 'Pedro', PHONE: [{ VALUE: '+573001234567' }] },
    { ID: '30', NAME: 'Ana', PHONE: [{ VALUE: '+948591234' }] },
    { ID: '50', NAME: '', PHONE: [] },
  ];

  const r = await informeCalidadDatos(auth, 7);
  assert.equal(r.analizadas, 5);
  assert.equal(r.problemas.sin_programa, 1);
  assert.equal(r.problemas.sin_contacto, 1);
  assert.equal(r.problemas.pais_no_atendido, 1, 'el +94 es el chileno al que le falta el 56');
  assert.equal(r.problemas.sin_nombre, 1);
  assert.equal(r.problemas.sin_telefono, 1);
});

test('da ejemplos para poder ir a mirarlos, pero no inunda', async () => {
  config.primerContactoPaises = ['+56'];
  deals = Array.from({ length: 10 }, (_, i) => ({ ID: String(i + 1), CONTACT_ID: String(i + 1), TITLE: 'x', UF_PROG: 'Maestría' }));
  contactos = deals.map((d) => ({ ID: d.ID, NAME: 'N', PHONE: [{ VALUE: '+573001234567' }] }));
  const r = await informeCalidadDatos(auth, 7);
  assert.equal(r.problemas.pais_no_atendido, 10);
  assert.equal(r.ejemplos.filter((e) => e.problema === 'pais_no_atendido').length, 3, 'tres ejemplos bastan');
  assert.ok(r.ejemplos[0].dealId > 0, 'el ejemplo dice a qué negociación ir');
});

test('un teléfono ilegible se distingue de uno de país no atendido', async () => {
  config.primerContactoPaises = ['+56'];
  deals = [{ ID: '1', CONTACT_ID: '10', TITLE: 'A', UF_PROG: 'Maestría' }];
  contactos = [{ ID: '10', NAME: 'Camila', PHONE: [{ VALUE: 'no tiene' }] }];
  const r = await informeCalidadDatos(auth, 7);
  assert.equal(r.problemas.telefono_invalido, 1);
  assert.equal(r.problemas.pais_no_atendido, 0);
});

test('sin negociaciones devuelve un informe vacío, no un error', async () => {
  deals = [];
  contactos = [];
  const r = await informeCalidadDatos(auth, 7);
  assert.equal(r.analizadas, 0);
  assert.equal(Object.values(r.problemas).reduce((a, b) => a + b, 0), 0);
  config.primerContactoPaises = [];
});
