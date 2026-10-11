import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Primer contacto con los leads que entraron y nunca escribieron. En el piloto entraron ~800 y el
// bot conversó con 81. Lo que más importa probar acá NO es que envíe, sino que NO envíe: escribirle
// primero a alguien necesita plantilla aprobada, una decisión de volumen y consentimiento claro.
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

mock.module('../src/crm/directory.ts', {
  namedExports: { getUsuarios: async (ids: number[]) => ids.map((id) => ({ id, nombre: `Asesor ${id}` })) },
});

const { candidatosPrimerContacto, enviarPrimerContacto, correrPrimerContacto, aE164, paisPermitido, paramsDe } = await import(
  '../src/crm/primerContacto'
);
const { config } = await import('../src/config');

const auth = { domain: 'test.bitrix24.com', access_token: 'tok' } as any;

function escenario() {
  consultas.length = 0;
  envios.length = 0;
  conversados = [{ dialogId: 'chat1', dealId: 2 }]; // con el 2 el bot YA conversó
  deals = [
    { ID: '1', CONTACT_ID: '10', TITLE: 'Magíster en Educación', DATE_CREATE: '2026-10-09', UF_PROG: 'Magíster en Educación' },
    { ID: '2', CONTACT_ID: '20', TITLE: 'Magíster en Psicología', DATE_CREATE: '2026-10-09' },
    { ID: '3', CONTACT_ID: '30', TITLE: 'Diplomado en IA', DATE_CREATE: '2026-10-09' },
    { ID: '4', CONTACT_ID: '', TITLE: 'Sin contacto', DATE_CREATE: '2026-10-09' },
  ];
  contactos = [
    { ID: '10', NAME: 'Camila', PHONE: [{ VALUE: '+56912345678' }] },
    { ID: '20', NAME: 'Pedro', PHONE: [{ VALUE: '+56911111111' }] },
    { ID: '30', NAME: 'Ana', PHONE: [] }, // sin teléfono: no hay a quién escribirle
  ];
  config.primerContactoActivo = false;
  config.primerContactoPlantilla = '';
  config.primerContactoMaxDiario = 50;
}

test('aE164 respeta un número ya internacional', () => {
  assert.equal(aE164('+57 300 1234567'), '+573001234567');
  assert.equal(aE164('0057 300 1234567'), '+573001234567');
  assert.equal(aE164('912345678', '+56'), '+56912345678');
  assert.equal(aE164('123', '+56'), null);
  assert.equal(aE164(''), null);
});

test('sin prefijo por defecto, un número ambiguo se descarta en vez de adivinarle el país', () => {
  // Los leads de Carver son 36% chilenos y 64% de otros países: asumir +56 en un número sin código
  // le manda el mensaje a un chileno cualquiera. Perder el contacto es más barato que eso.
  assert.equal(aE164('3001234567', ''), null);
  assert.equal(aE164('+573001234567', ''), '+573001234567', 'uno internacional sigue pasando');
});

test('un número de un país fuera de la lista no se contacta', async () => {
  // Caso real de la muestra de Carver: "+94859…" es un chileno al que le falta el 56. Con ese
  // prefijo el mensaje sale a Sri Lanka, y se paga.
  escenario();
  config.primerContactoPaises = ['+593', '+57', '+56'];
  contactos = [
    { ID: '10', NAME: 'Camila', PHONE: [{ VALUE: '+56912345678' }] },
    { ID: '40', NAME: 'María', PHONE: [{ VALUE: '+948591234' }] },
  ];
  deals = [
    { ID: '11', CONTACT_ID: '10', TITLE: 'A', DATE_CREATE: '2026-10-10' },
    { ID: '12', CONTACT_ID: '40', TITLE: 'B', DATE_CREATE: '2026-10-10' },
  ];
  conversados = [];
  const c = await candidatosPrimerContacto(auth, 7);
  assert.deepEqual(c.map((x) => x.contactId), [10]);
  config.primerContactoPaises = [];
});

test('sin lista de países configurada no se filtra nada', () => {
  config.primerContactoPaises = [];
  assert.equal(paisPermitido('+948591234'), true);
  config.primerContactoPaises = ['+56'];
  assert.equal(paisPermitido('+948591234'), false);
  assert.equal(paisPermitido('+56912345678'), true);
  config.primerContactoPaises = [];
});

test('los parámetros salen en el orden que pide la plantilla', () => {
  // Una plantilla dice "Hola {{1}}, soy {{2}} de Carver, sobre {{3}}" y otra "Hola, soy {{1}},
  // sobre {{2}}": el orden es configuración, no código.
  const c: any = { nombre: 'Camila', programa: 'Maestría en Psicología', asesor: 'Ignacio Ribera' };
  config.primerContactoParams = ['nombre', 'asesor', 'programa'];
  assert.deepEqual(paramsDe(c), ['Camila', 'Ignacio Ribera', 'Maestría en Psicología']);
  config.primerContactoParams = ['asesor', 'programa'];
  assert.deepEqual(paramsDe(c), ['Ignacio Ribera', 'Maestría en Psicología']);
  config.primerContactoParams = ['nombre', 'programa'];
});

test('sin nombre o sin asesor no manda un hueco vacío al cliente', () => {
  config.primerContactoParams = ['nombre', 'asesor'];
  const r = paramsDe({ nombre: '', asesor: '' } as any);
  assert.equal(r[0], 'hola');
  assert.ok(r[1].length > 0, 'cae al nombre de la marca en vez de dejarlo en blanco');
  config.primerContactoParams = ['nombre', 'programa'];
});

test('toma el nombre del responsable de la negociación', async () => {
  escenario();
  deals = [{ ID: '11', CONTACT_ID: '10', TITLE: 'A', DATE_CREATE: '2026-10-10', ASSIGNED_BY_ID: '1313' }];
  conversados = [];
  const c = await candidatosPrimerContacto(auth, 7);
  assert.equal(c[0].asesor, 'Asesor 1313');
});

test('una persona con dos negociaciones recibe un solo mensaje', async () => {
  escenario();
  deals = [
    { ID: '11', CONTACT_ID: '10', TITLE: 'Formulario A', DATE_CREATE: '2026-10-10' },
    { ID: '12', CONTACT_ID: '10', TITLE: 'Formulario B', DATE_CREATE: '2026-10-09' },
  ];
  conversados = [];
  const c = await candidatosPrimerContacto(auth, 7);
  assert.equal(c.length, 1, 'dos formularios de la misma persona no son dos destinatarios');
  assert.equal(c[0].dealId, 11, 'se queda con la negociación más reciente');
});

test('sin embudos configurados no filtra por embudo', async () => {
  // Acá el 0 es un embudo VÁLIDO de Bitrix, así que no se puede descartar como en las otras listas
  // de IDs. Con el filtro mal escrito, una variable sin definir dejaba [0] y la consulta pedía las
  // negociaciones del embudo equivocado: en producción devolvía cero candidatos entre 21.955.
  assert.deepEqual(config.primerContactoCategorias, []);
  escenario();
  await candidatosPrimerContacto(auth, 7);
  const q = consultas.find((c) => c.method === 'crm.deal.list');
  assert.equal(q.params.filter['@CATEGORY_ID'], undefined, 'sin configurar, no debe filtrar por embudo');
});

test('deja fuera a quien ya conversó con el bot y a quien no tiene teléfono', async () => {
  escenario();
  const c = await candidatosPrimerContacto(auth, 7);
  assert.deepEqual(c.map((x) => x.dealId), [1], 'solo el 1: el 2 ya conversó, el 3 no tiene teléfono, el 4 no tiene contacto');
  assert.equal(c[0].nombre, 'Camila');
  assert.equal(c[0].programa, 'Magíster en Educación');
});

test('prefiere el campo de programa por sobre el título de la negociación', async () => {
  escenario();
  deals = [{ ID: '7', CONTACT_ID: '10', TITLE: 'Consulta web – Camila', DATE_CREATE: '2026-10-09', UF_PROG: 'Magíster en Educación' }];
  const c = await candidatosPrimerContacto(auth, 7);
  assert.equal(c[0].programa, 'Magíster en Educación');
});

test('APAGADO por defecto: no le escribe a nadie', async () => {
  escenario();
  const r = await enviarPrimerContacto({
    dealId: 1, contactId: 10, nombre: 'Camila', telefono: '+56912345678', programa: 'x', creado: '2026-10-09',
  });
  assert.deepEqual(r, { enviado: false, motivo: 'desactivado' });
  assert.equal(envios.length, 0);
});

test('encendido pero sin plantilla tampoco envía', async () => {
  escenario();
  config.primerContactoActivo = true;
  const r = await enviarPrimerContacto({
    dealId: 1, contactId: 10, nombre: 'Camila', telefono: '+56912345678', programa: 'x', creado: '2026-10-09',
  });
  assert.deepEqual(r, { enviado: false, motivo: 'sin_plantilla' });
  assert.equal(envios.length, 0);
});

test('con todo configurado envía una vez y nunca más a la misma negociación', async () => {
  escenario();
  config.primerContactoActivo = true;
  config.primerContactoPlantilla = 'primer_contacto_v1';
  // El horario permitido se fija acá para que la prueba no dependa de la hora a la que corra.
  config.seguimientoHoraInicio = 0;
  config.seguimientoHoraFin = 24;
  const cand = { dealId: 99, contactId: 10, nombre: 'Camila', telefono: '+56912345678', programa: 'Magíster', creado: '2026-10-09' };

  assert.deepEqual(await enviarPrimerContacto(cand), { enviado: true });
  assert.equal(envios.length, 1);
  assert.equal(envios[0].template, 'primer_contacto_v1');
  assert.equal(envios[0].phoneE164, '+56912345678');
  assert.deepEqual(envios[0].params, ['Camila', 'Magíster']);

  assert.deepEqual(await enviarPrimerContacto(cand), { enviado: false, motivo: 'ya_contactado' });
  assert.equal(envios.length, 1, 'insistir a quien nunca contestó es spam');
});

test('fuera del horario permitido no escribe', async () => {
  escenario();
  config.primerContactoActivo = true;
  config.primerContactoPlantilla = 'p';
  config.seguimientoHoraInicio = 23;
  config.seguimientoHoraFin = 24; // ventana de una hora: prácticamente siempre está fuera
  const r = await enviarPrimerContacto({
    dealId: 123, contactId: 10, nombre: 'x', telefono: '+56912345678', programa: 'y', creado: '2026-10-09',
  });
  if (r.motivo) assert.equal(r.motivo, 'fuera_de_horario');
});

test('simular recorre todo sin enviar nada', async () => {
  escenario();
  config.primerContactoActivo = true;
  config.primerContactoPlantilla = 'p';
  const r = await correrPrimerContacto(auth, { dias: 7, simular: true });
  assert.equal(r.candidatos, 1);
  assert.equal(r.enviados, 0);
  assert.equal(envios.length, 0, 'simular no le escribe a nadie');
  assert.equal(r.muestra.length, 1);
});
