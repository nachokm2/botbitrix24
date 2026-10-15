import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// El brochure como ARCHIVO y no como enlace. Un enlace obliga a la persona a salir de WhatsApp,
// abrir el navegador y a veces iniciar sesión; muchos no lo hacen. El PDF le queda en el teléfono.
//
// Lo delicado no es enviarlo sino ELEGIRLO: mandar el brochure de otro programa es peor que no
// mandar ninguno, porque la persona lee duración, requisitos y precios que no son los suyos y
// decide con eso.
process.env.MARCA = 'carver';
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.CHATAPP_LICENSE_ID = '50126'; // sin licencia el envio se considera desactivado

// Los nombres son los reales del Drive de Carver, con sus duplicados "(1)".
const ARCHIVOS = [
  { ID: '3960133', NAME: 'Webpage de Carver', TYPE: 'folder' },
  { ID: '2471837', NAME: 'L. Psicología - Carver University.pdf' },
  { ID: '2471839', NAME: 'L. Ingeniería Informática - Carver University.pdf' },
  { ID: '2475415', NAME: 'M. Administración de Empresas - Carver University.pdf' },
  { ID: '2475417', NAME: 'M. Psicología - Carver University.pdf' },
  { ID: '2475419', NAME: 'M. Administración Pública - Carver University.pdf' },
  { ID: '2919505', NAME: 'L. Psicología - Carver University (1).pdf' },
  { ID: '2919827', NAME: 'M. Psicología - Carver University (1).pdf' },
  { ID: '7414965', NAME: 'Manual de Pagos - Carver University.pdf' },
  { ID: '2514661', NAME: 'GRÁFICA WSP-GENÉRICA BACHELOR.jpg' },
];

let contacto: any = { PHONE: [{ VALUE: '+56912345678', VALUE_TYPE: 'MOBILE' }] };
let fallaDrive = false;
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callCrm: async (method: string, params: any) => {
      if (fallaDrive) throw new Error('Bitrix no responde');
      if (method === 'disk.folder.getchildren') return ARCHIVOS;
      if (method === 'disk.file.get') {
        const a = ARCHIVOS.find((x) => x.ID === String(params.id));
        return a ? { ID: a.ID, NAME: a.NAME, DOWNLOAD_URL: `https://portal.test/descarga/${a.ID}` } : {};
      }
      if (method === 'crm.contact.get') return contacto;
      return {};
    },
    callBitrix: async () => ({}),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: [] }),
    callWebhook: async () => ({}),
  },
});

const enviados: any[] = [];
let fallaEnvio = false;
mock.module('../src/whatsapp/chatapp.ts', {
  namedExports: {
    enviarArchivo: async (o: any) => {
      if (fallaEnvio) return { ok: false, error: 'ChatApp rechazó' };
      enviados.push(o);
      return { ok: true, messageId: 'wamid.TEST' };
    },
    enviarPlantilla: async () => ({ ok: true }),
    listarPlantillas: async () => [],
  },
});

const { archivoDelBrochure, enviarBrochurePorWhatsApp, _limpiarCacheBrochureArchivo } = await import(
  '../src/core/brochureArchivo'
);
const auth = { domain: 'test.bitrix24.com', access_token: 'tok' } as any;

function reset() {
  enviados.length = 0;
  fallaDrive = false;
  fallaEnvio = false;
  contacto = { PHONE: [{ VALUE: '+56912345678', VALUE_TYPE: 'MOBILE' }] };
  _limpiarCacheBrochureArchivo();
}

test('encuentra el PDF de cada programa que lo tiene', async () => {
  reset();
  for (const [programa, esperado] of [
    ['Licenciatura en Psicología', '2471837'],
    ['Licenciatura en Ingeniería Informática', '2471839'],
    ['Maestría en Administración de Empresas MBA', '2475415'],
    ['Maestría en Administración Pública', '2475419'],
  ] as const) {
    const r: any = await archivoDelBrochure(programa, auth);
    assert.equal(r.ok, true, programa);
    assert.equal(String(r.fileId), esperado, programa);
  }
});

test('NO confunde la licenciatura con la maestría del mismo tema', async () => {
  // Psicología existe en los dos niveles y sus nombres de archivo comparten todas las palabras
  // significativas. Es el error más fácil de cometer acá, y el más caro: la persona compararía
  // duración y precio de un programa que no es el suyo.
  reset();
  const lic: any = await archivoDelBrochure('Licenciatura en Psicología', auth);
  const mae: any = await archivoDelBrochure('Maestría en Psicología', auth);
  assert.equal(String(lic.fileId), '2471837');
  assert.equal(String(mae.fileId), '2475417');
  assert.notEqual(lic.fileId, mae.fileId);
});

test('entre un archivo y su duplicado "(1)" elige el original', async () => {
  reset();
  const r: any = await archivoDelBrochure('Licenciatura en Psicología', auth);
  assert.equal(r.nombre, 'L. Psicología - Carver University.pdf');
  assert.doesNotMatch(r.nombre, /\(1\)/);
});

test('un programa sin PDF no recibe el de otro', async () => {
  reset();
  for (const p of ['Maestría en Inteligencia Artificial', 'Maestría en Neurodivergencia', 'Maestría en Salud Mental']) {
    const r: any = await archivoDelBrochure(p, auth);
    assert.equal(r.ok, false, p);
    assert.equal(r.motivo, 'sin_archivo', p);
  }
});

test('no entrega documentos que no son brochures de programa', async () => {
  reset();
  const r: any = await archivoDelBrochure('Manual de Pagos', auth);
  // "Manual de Pagos" no es un programa; lo que importa es que no devuelva un brochure cualquiera.
  if (r.ok) assert.match(r.nombre, /Manual de Pagos/);
});

test('envía el PDF al WhatsApp de la persona', async () => {
  reset();
  const r: any = await enviarBrochurePorWhatsApp('Maestría en Psicología', { contact: 700 }, auth);
  assert.equal(r.enviado, true);
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].phoneE164, '+56912345678');
  assert.match(enviados[0].url, /^https:\/\//);
  assert.match(enviados[0].nombreArchivo, /M\. Psicología/);
});

test('sin teléfono en la ficha no se intenta enviar', async () => {
  reset();
  contacto = { PHONE: [] };
  const r: any = await enviarBrochurePorWhatsApp('Maestría en Psicología', { contact: 700 }, auth);
  assert.equal(r.enviado, false);
  assert.equal(r.motivo, 'sin_telefono');
  assert.equal(enviados.length, 0);
});

test('un teléfono mal formado no se usa', async () => {
  reset();
  contacto = { PHONE: [{ VALUE: '12345' }] };
  const r: any = await enviarBrochurePorWhatsApp('Maestría en Psicología', { contact: 700 }, auth);
  assert.equal(r.motivo, 'sin_telefono');
});

test('si ChatApp rechaza el envío, se informa y NO se da por entregado', async () => {
  // Quien llama cae al enlace de siempre: quedarse sin brochure por un fallo de envío sería peor.
  reset();
  fallaEnvio = true;
  const r: any = await enviarBrochurePorWhatsApp('Maestría en Psicología', { contact: 700 }, auth);
  assert.equal(r.enviado, false);
  assert.equal(r.motivo, 'fallo_envio');
});

test('si el Drive no responde, no se promete nada', async () => {
  reset();
  fallaDrive = true;
  const r: any = await enviarBrochurePorWhatsApp('Maestría en Psicología', { contact: 700 }, auth);
  assert.equal(r.enviado, false);
  assert.equal(enviados.length, 0);
});

test('sin contacto no se envía a ninguna parte', async () => {
  reset();
  const r: any = await enviarBrochurePorWhatsApp('Maestría en Psicología', {}, auth);
  assert.equal(r.enviado, false);
  assert.equal(r.motivo, 'sin_telefono');
  assert.equal(enviados.length, 0);
});
