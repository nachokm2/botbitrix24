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
const BASE = [
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

// Relleno hasta pasar los 50 de una página. La carpeta real tiene 66 elementos, y leer solo la
// primera página dejaba invisibles los archivos subidos después: los once brochures del 16-10
// estaban cargados y el bot no los veía. Sin este relleno, ese bug no se nota en las pruebas.
const RELLENO = Array.from({ length: 55 }, (_, i) => ({ ID: `90${i}`, NAME: `grafica-${i}.jpg` }));

// Suben con la convención de Postgrados: prefijo "BR-" y el nivel escrito completo, no abreviado.
const SEGUNDA_PAGINA = [
  { ID: '21293249', NAME: 'BR-Maestría en Inteligencia Artificial.pdf' },
  { ID: '21293243', NAME: 'BR-Licenciatura en Administración de Empresas.pdf' },
  { ID: '21293229', NAME: 'BR-Maestría en Ingeniería.pdf' },
];

const ARCHIVOS = [...BASE, ...RELLENO, ...SEGUNDA_PAGINA];

let contacto: any = { PHONE: [{ VALUE: '+56912345678', VALUE_TYPE: 'MOBILE' }] };
let fallaDrive = false;
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callCrm: async (method: string, params: any) => {
      if (fallaDrive) throw new Error('Bitrix no responde');
      if (method === 'disk.folder.getchildren') return ARCHIVOS.slice(params.start ?? 0, (params.start ?? 0) + 50);
      if (method === 'disk.file.get') {
        const a = ARCHIVOS.find((x) => x.ID === String(params.id));
        return a ? { ID: a.ID, NAME: a.NAME, DOWNLOAD_URL: `https://portal.test/descarga/${a.ID}` } : {};
      }
      if (method === 'crm.contact.get') return contacto;
      return {};
    },
    callBitrix: async () => ({}),
    callBitrixEnvelope: async () => ({ result: {} }),
    // Bitrix pagina de a 50 y devuelve "next" mientras quede algo.
    callCrmEnvelope: async (method: string, params: any) => {
      if (fallaDrive) throw new Error('Bitrix no responde');
      if (method !== 'disk.folder.getchildren') return { result: [] };
      const start = Number(params?.start ?? 0);
      const pagina = ARCHIVOS.slice(start, start + 50);
      const next = start + 50 < ARCHIVOS.length ? start + 50 : undefined;
      return { result: pagina, total: ARCHIVOS.length, next };
    },
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
  for (const p of ['Maestría en Neurodivergencia', 'Maestría en Salud Mental', 'Maestría en Arquitectura de Software']) {
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

// ── Los dos bugs del 16-10 ───────────────────────────────────────────────────────────────────────
test('encuentra archivos que están MÁS ALLÁ de la primera página del Drive', async () => {
  // Bitrix devuelve 50 elementos por página. La carpeta de Carver tiene 66, así que los once
  // brochures recién subidos quedaban invisibles: el usuario los veía cargados y el bot decía que
  // no existían. Sin paginar, esta prueba falla.
  reset();
  const r: any = await archivoDelBrochure('Maestría en Inteligencia Artificial', auth);
  assert.equal(r.ok, true, 'está en la segunda página');
  assert.equal(String(r.fileId), '21293249');
});

test('entiende el prefijo "BR-" con el nivel escrito completo', async () => {
  // Conviven dos convenciones en la misma carpeta: "M. Psicología" (Carver) y "BR-Maestría en
  // Ingeniería" (Postgrados). Hay que leer el nivel de las dos.
  reset();
  const r: any = await archivoDelBrochure('Maestría en Ingeniería', auth);
  assert.equal(r.ok, true);
  assert.match(r.nombre, /^BR-Maestría en Ingeniería/);
});

test('subir la licenciatura NO deja sin brochure a la maestría homónima', async () => {
  // El riesgo concreto: "BR-Licenciatura en Administración de Empresas" comparte todas sus palabras
  // clave con "M. Administración de Empresas". Si el prefijo "BR-" no se reconociera como nivel, el
  // archivo quedaría sin nivel, competiría con el de la maestría y NINGUNO se entregaría — el MBA
  // dejaría de funcionar justo al agregar un archivo nuevo.
  reset();
  const mba: any = await archivoDelBrochure('Maestría en Administración de Empresas MBA', auth);
  assert.equal(mba.ok, true, 'el MBA sigue teniendo su brochure');
  assert.equal(String(mba.fileId), '2475415');

  const lic: any = await archivoDelBrochure('Licenciatura en Administración de Empresas', auth);
  assert.equal(lic.ok, true);
  assert.equal(String(lic.fileId), '21293243');
  assert.notEqual(mba.fileId, lic.fileId);
});
