import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// El tope diario de primeros contactos. Va en su propio archivo porque es un contador por proceso:
// compartiéndolo con las otras pruebas, los envíos de una gastarían el cupo de la otra.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.BITRIX_UF_PROGRAMA = 'UF_PROG';

let deals: any[] = [];
let contactos: any[] = [];
const consultas: any[] = [];
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callCrm: async (method: string, params: any) => {
      consultas.push({ method, params });
      if (method === 'crm.deal.list') return params.start ? [] : deals;
      if (method === 'crm.contact.list') {
        const ids = params.filter['@ID'];
        return contactos.filter((c) => ids.includes(Number(c.ID)));
      }
      return [];
    },
    callBitrix: async () => ({}),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: {} }),
    callWebhook: async () => ({}),
  },
});

let conversados: Array<{ dialogId: string; dealId: number }> = [];
mock.module('../src/store/db.ts', {
  namedExports: {
    dbDialogosConDeal: async () => conversados,
    dbInsertAudit: async () => {},
    dbHuboOperadorDespuesDe: async () => false,
    dbDialogosPorTextoPrograma: async () => [],
  },
});

const envios: any[] = [];
mock.module('../src/whatsapp/template.ts', {
  namedExports: {
    enviarPlantillaWhatsApp: async (o: any) => {
      envios.push(o);
      return { ok: true };
    },
    construirPayloadMeta: () => ({}),
  },
});

mock.module('../src/obs/audit.ts', { namedExports: { audit: async () => {} } });

const { correrPrimerContacto } = await import('../src/crm/primerContacto');
const { config } = await import('../src/config');

const auth = { domain: 'test.bitrix24.com', access_token: 'tok' } as any;

test('el tope diario corta la corrida en vez de seguir enviando', async () => {
  consultas.length = 0;
  envios.length = 0;
  config.primerContactoActivo = true;
  config.primerContactoPlantilla = 'p';
  config.seguimientoHoraInicio = 0;
  config.seguimientoHoraFin = 24;
  config.primerContactoMaxDiario = 1;
  deals = [
    { ID: '41', CONTACT_ID: '10', TITLE: 'A', DATE_CREATE: '2026-10-09' },
    { ID: '42', CONTACT_ID: '20', TITLE: 'B', DATE_CREATE: '2026-10-09' },
  ];
  contactos = [
    { ID: '10', NAME: 'Camila', PHONE: [{ VALUE: '+56912345678' }] },
    { ID: '20', NAME: 'Pedro', PHONE: [{ VALUE: '+56911111111' }] },
  ];
  conversados = [];
  const r = await correrPrimerContacto(auth, { dias: 7 });
  assert.equal(r.enviados, 1);
  assert.equal(r.descartados.tope_diario, 1);
  assert.equal(envios.length, 1);
});

