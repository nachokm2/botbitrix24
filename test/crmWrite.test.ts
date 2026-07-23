import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Test de integración de la escritura al CRM (actualizarDatosCliente). Mockea el cliente Bitrix
// (../src/bitrix/client) para capturar los métodos REST invocados y sus payloads, SIN tocar la red.
// Verifica la fusión de multicampos: agregar un email nuevo NO debe borrar el existente.
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';
process.env.BITRIX_UF_PROGRAMA = 'UF_CRM_PROGRAMA_TEST';
process.env.BITRIX_UF_BROCHURE_FILE = 'UF_CRM_BROCHURE_TEST';
process.env.BITRIX_DRIVE_FOLDER_MAGISTER = '111';
process.env.BITRIX_DRIVE_FOLDER_DIPLOMADO = '222';

type Call = { method: string; params: any };
const calls: Call[] = [];
let responder: (method: string, params: any) => any = () => ({});

const record = async (method: string, params: any) => {
  calls.push({ method, params });
  return responder(method, params);
};

const recordEnvelope = async (method: string, params: any) => {
  calls.push({ method, params });
  return { result: responder(method, params) ?? [] };
};

mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: record,
    callCrm: record,
    callBitrixEnvelope: recordEnvelope,
    callCrmEnvelope: recordEnvelope,
    callWebhook: async () => ({}),
  },
});

// buscarBrochureDrive descarga el contenido con fetch() directo (la URL ya trae el token de
// Bitrix) — se mockea el global para simular esa descarga sin tocar la red.
const realFetch = globalThis.fetch;
(globalThis as any).fetch = async (url: string) => {
  if (String(url).startsWith('http://descarga.test/')) {
    return { ok: true, arrayBuffer: async () => new TextEncoder().encode('contenido-pdf-de-prueba').buffer } as any;
  }
  return realFetch(url as any);
};

const { actualizarDatosCliente } = await import('../src/crm/crmWrite');

const auth = { domain: '', access_token: '' } as any;

test('actualizarDatosCliente: fusiona email nuevo sin borrar el existente', async () => {
  calls.length = 0;
  responder = (method) => {
    if (method === 'crm.contact.get') {
      return {
        EMAIL: [{ ID: '10', VALUE: 'antiguo@correo.cl', VALUE_TYPE: 'WORK' }],
        PHONE: [{ ID: '20', VALUE: '+56911112222', VALUE_TYPE: 'MOBILE' }],
      };
    }
    return {};
  };

  const r = await actualizarDatosCliente({ contact: 5 }, undefined, { nombre: 'Ana', email: 'nuevo@correo.cl' }, auth);

  assert.equal(r.ok, true);
  assert.deepEqual(r.actualizado, ['contact#5']);

  // Se leyó el contacto para fusionar.
  assert.ok(calls.find((c) => c.method === 'crm.contact.get'), 'lee el contacto antes de fusionar');

  // El update conserva el email antiguo y agrega el nuevo.
  const update = calls.find((c) => c.method === 'crm.contact.update');
  assert.ok(update, 'actualiza el contacto');
  assert.equal(update!.params.fields.NAME, 'Ana');
  const emails = update!.params.fields.EMAIL.map((e: any) => e.VALUE);
  assert.ok(emails.includes('antiguo@correo.cl'), 'conserva el email existente');
  assert.ok(emails.includes('nuevo@correo.cl'), 'agrega el email nuevo');
  assert.equal(update!.params.fields.EMAIL.length, 2);

  // Deja la nota trazable en el timeline.
  assert.ok(calls.find((c) => c.method === 'crm.timeline.comment.add'), 'deja nota en el timeline');
});

test('actualizarDatosCliente: no duplica un email que ya está presente', async () => {
  calls.length = 0;
  responder = (method) => {
    if (method === 'crm.contact.get') {
      return { EMAIL: [{ ID: '10', VALUE: 'ana@correo.cl', VALUE_TYPE: 'WORK' }] };
    }
    return {};
  };

  await actualizarDatosCliente({ contact: 7 }, undefined, { email: 'ana@correo.cl' }, auth);

  const update = calls.find((c) => c.method === 'crm.contact.update');
  assert.ok(update, 'igual emite update');
  assert.equal(update!.params.fields.EMAIL.length, 1, 'no duplica el email ya presente');
});

test('actualizarDatosCliente: busca el brochure en el Drive, lo descarga y lo guarda con el programa de interés', async () => {
  calls.length = 0;
  responder = (method) => {
    if (method === 'disk.folder.getchildren') {
      return [
        { TYPE: 'file', NAME: 'Magíster - Dirección de Empresas - MBA.pdf', ID: 1 },
        { TYPE: 'file', NAME: 'Magíster - Inteligencia Artificial.pdf', ID: 2 },
      ];
    }
    if (method === 'disk.file.get') {
      return { NAME: 'Magíster - Inteligencia Artificial.pdf', DOWNLOAD_URL: 'http://descarga.test/2' };
    }
    if (method === 'crm.deal.get') return {}; // sin programa previo → no es "sin cambios"
    return {};
  };

  await actualizarDatosCliente({ deal: 42 }, undefined, { programa_interes: 'Magíster en Inteligencia Artificial' }, auth);

  const listado = calls.find((c) => c.method === 'disk.folder.getchildren');
  assert.ok(listado, 'lista la carpeta del Drive');
  assert.equal(listado!.params.id, 111, 'usa la carpeta de Magíster (BITRIX_DRIVE_FOLDER_MAGISTER)');

  assert.ok(calls.find((c) => c.method === 'disk.file.get' && c.params.id === 2), 'descarga el archivo correcto (no el de MBA)');

  const update = calls.find((c) => c.method === 'crm.deal.update');
  assert.ok(update, 'actualiza el deal');
  assert.equal(update!.params.fields.UF_CRM_PROGRAMA_TEST, 'Magíster en Inteligencia Artificial');
  const fileData = update!.params.fields.UF_CRM_BROCHURE_TEST?.fileData;
  assert.equal(fileData?.[0], 'Magíster - Inteligencia Artificial.pdf');
  assert.equal(Buffer.from(fileData?.[1], 'base64').toString(), 'contenido-pdf-de-prueba');
});

test('actualizarDatosCliente: no vuelve a descargar el brochure si el programa no cambió', async () => {
  calls.length = 0;
  responder = (method) => {
    if (method === 'crm.deal.get') return { UF_CRM_PROGRAMA_TEST: 'Magíster en Inteligencia Artificial' };
    return {};
  };

  await actualizarDatosCliente({ deal: 44 }, undefined, { programa_interes: 'Magíster en Inteligencia Artificial' }, auth);

  assert.ok(!calls.find((c) => c.method === 'disk.folder.getchildren'), 'no relista el Drive');
  const update = calls.find((c) => c.method === 'crm.deal.update');
  assert.equal(update!.params.fields.UF_CRM_BROCHURE_TEST, undefined, 'no reenvía el brochure');
});

test('actualizarDatosCliente: sin programa de interés no toca el UF del brochure', async () => {
  calls.length = 0;
  responder = () => ({});

  await actualizarDatosCliente({ deal: 43 }, undefined, { comentario: 'solo un comentario' }, auth);

  const update = calls.find((c) => c.method === 'crm.deal.update');
  assert.ok(update, 'igual actualiza el deal (por el comentario)');
  assert.equal(update!.params.fields.UF_CRM_BROCHURE_TEST, undefined);
});

test('actualizarDatosCliente: sin entidad CRM y sin chat devuelve error claro', async () => {
  calls.length = 0;
  const r = await actualizarDatosCliente({}, undefined, { nombre: 'Sin Entidad' }, auth);
  assert.equal(r.ok, false);
  assert.match(String(r.error), /entidad CRM/i);
});
