import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Reactivación de conversaciones frías: gente que SÍ habló con el bot y se apagó. Es el público más
// barato de recuperar porque el interés ya está demostrado, pero pasadas las 24 horas WhatsApp no
// deja texto libre, así que necesita plantilla y los mismos frenos que el primer contacto.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.BITRIX_UF_PROGRAMA = 'UF_PROG';

let frias: any[] = [];
mock.module('../src/store/db.ts', {
  namedExports: {
    dbConversacionesFrias: async () => frias,
    dbInsertAudit: async () => {},
    dbDialogosConDeal: async () => [],
    dbDialogosPorTextoPrograma: async () => [],
    dbHuboOperadorDespuesDe: async () => false,
  },
});

let deals: any[] = [];
let contactos: any[] = [];
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callCrm: async (method: string, params: any) => {
      if (method === 'crm.deal.list') return deals.filter((d) => params.filter['@ID'].includes(Number(d.ID)));
      if (method === 'crm.contact.list') return contactos.filter((c) => params.filter['@ID'].includes(Number(c.ID)));
      return [];
    },
    callBitrix: async () => ({}),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: {} }),
    callWebhook: async () => ({}),
  },
});

mock.module('../src/crm/directory.ts', {
  namedExports: { getUsuarios: async (ids: number[]) => ids.map((id) => ({ id, nombre: `Asesor ${id}` })) },
});

let excluido = false;
mock.module('../src/crm/exclusion.ts', {
  namedExports: { estaExcluido: async () => excluido, excluir: async () => {}, pideNoMolestar: () => false },
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

const { candidatosReactivacion, reactivar, correrReactivacion } = await import('../src/crm/reactivacion');
const { config } = await import('../src/config');

const auth = { domain: 'test.bitrix24.com', access_token: 'tok' } as any;
const haceDias = (d: number) => new Date(Date.now() - d * 86400_000).toISOString();

function escenario() {
  envios.length = 0;
  excluido = false;
  frias = [
    { dialogId: 'chat1', dealId: 11, ultimoTurno: haceDias(5), turnos: 6 },
    { dialogId: 'chat2', dealId: 12, ultimoTurno: haceDias(9), turnos: 3 },
  ];
  deals = [
    { ID: '11', CONTACT_ID: '10', TITLE: 'x', ASSIGNED_BY_ID: '1313', UF_PROG: 'Maestría en Psicología' },
    { ID: '12', CONTACT_ID: '20', TITLE: 'Licenciatura', ASSIGNED_BY_ID: '1313' },
  ];
  contactos = [
    { ID: '10', NAME: 'Camila', PHONE: [{ VALUE: '+56912345678' }] },
    { ID: '20', NAME: 'Pedro', PHONE: [{ VALUE: '+573001234567' }] },
  ];
  config.reactivacionActiva = false;
  config.reactivacionPlantillas = [];
  config.reactivacionMaxDiario = 30;
  config.primerContactoParams = ['nombre', 'asesor', 'programa'];
  config.primerContactoPaises = [];
  config.seguimientoHoraInicio = 0;
  config.seguimientoHoraFin = 24;
}

const unFrio = () => ({
  dialogId: 'chat1', dealId: 11, contactId: 10, nombre: 'Camila',
  telefono: '+56912345678', programa: 'Maestría en Psicología', asesor: 'Ignacio Ribera', diasSinHablar: 5,
});

test('arma los candidatos con programa, asesor y días sin hablar', async () => {
  escenario();
  const c = await candidatosReactivacion(auth);
  assert.equal(c.length, 2);
  assert.equal(c[0].programa, 'Maestría en Psicología');
  assert.equal(c[0].asesor, 'Asesor 1313');
  assert.ok(c[0].diasSinHablar >= 4 && c[0].diasSinHablar <= 6);
});

test('una persona con dos conversaciones frías recibe un solo mensaje', async () => {
  escenario();
  frias = [
    { dialogId: 'chat1', dealId: 11, ultimoTurno: haceDias(5), turnos: 6 },
    { dialogId: 'chat3', dealId: 13, ultimoTurno: haceDias(7), turnos: 2 },
  ];
  deals.push({ ID: '13', CONTACT_ID: '10', TITLE: 'otra', ASSIGNED_BY_ID: '1313' });
  const c = await candidatosReactivacion(auth);
  assert.equal(c.length, 1);
});

test('apagada por defecto: no escribe', async () => {
  escenario();
  assert.deepEqual(await reactivar(unFrio()), { enviado: false, motivo: 'desactivado' });
  assert.equal(envios.length, 0);
});

test('respeta la lista de exclusión', async () => {
  escenario();
  config.reactivacionActiva = true;
  config.reactivacionPlantillas = ['uuid-r'];
  excluido = true;
  assert.deepEqual(await reactivar(unFrio()), { enviado: false, motivo: 'excluido' });
  assert.equal(envios.length, 0);
});

test('envía una vez y no insiste con la misma persona', async () => {
  escenario();
  config.reactivacionActiva = true;
  config.reactivacionPlantillas = ['uuid-r'];
  const f = { ...unFrio(), contactId: 555 };
  assert.deepEqual(await reactivar(f), { enviado: true });
  assert.equal(envios[0].template, 'uuid-r');
  assert.deepEqual(envios[0].params, ['Camila', 'Ignacio Ribera', 'Maestría en Psicología']);
  assert.deepEqual(await reactivar(f), { enviado: false, motivo: 'ya_reactivado' });
  assert.equal(envios.length, 1);
});

test('simular no escribe a nadie', async () => {
  escenario();
  config.reactivacionActiva = true;
  config.reactivacionPlantillas = ['uuid-r'];
  const r = await correrReactivacion(auth, { simular: true });
  assert.equal(r.candidatos, 2);
  assert.equal(r.enviados, 0);
  assert.equal(envios.length, 0);
});

test('un número de país no permitido queda fuera', async () => {
  escenario();
  config.primerContactoPaises = ['+56'];
  const c = await candidatosReactivacion(auth);
  assert.deepEqual(c.map((x) => x.contactId), [10], 'el colombiano queda fuera');
  config.primerContactoPaises = [];
});
