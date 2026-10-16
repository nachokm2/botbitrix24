import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// El documento académico del postulante. No es uno solo: Carver pide distinto según el nivel al que
// entra, y así está escrito en los requisitos de cada ficha.
//
//   Licenciatura → "Diploma oficial de escuela secundaria o equivalente"
//   Maestría     → "título profesional o grado académico"
//
// Guardarlos en el mismo campo, o en el de la cédula, hace invisible cuál falta: nadie lo vuelve a
// pedir y la matrícula se traba semanas después sin que quede claro por qué.
process.env.MARCA = 'carver';
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

let deal: Record<string, any> = {};
let falla = false;
const escrituras: any[] = [];
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callCrm: async (method: string, params: any) => {
      if (method === 'crm.deal.update') {
        if (falla) throw new Error('Bitrix rechazó la escritura');
        escrituras.push(params);
        Object.assign(deal, params.fields);
        return true;
      }
      if (method === 'crm.deal.get') return deal;
      return {};
    },
    callBitrix: async () => ({}),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: [] }),
    callWebhook: async () => ({}),
  },
});
mock.module('../src/obs/audit.ts', { namedExports: { audit: async () => {} } });

const { registrarDocumentoAcademico, nivelDelPrograma, DOCUMENTO_DE } = await import('../src/crm/documentoAcademico');
const { config } = await import('../src/config');
const auth = { domain: 'test.bitrix24.com', access_token: 'tok' } as any;

const IMG = { base64: 'ZmFrZQ==', mediaType: 'image/jpeg' };
function reset() {
  escrituras.length = 0;
  deal = {};
  falla = false;
}
const campoEscrito = () => Object.keys(escrituras[0]?.fields ?? {})[0];

test('el nivel se deduce del programa, en español y en inglés', () => {
  assert.equal(nivelDelPrograma('Licenciatura en Psicología'), 'licenciatura');
  assert.equal(nivelDelPrograma('Bachelor of Science in Psychology'), 'licenciatura');
  assert.equal(nivelDelPrograma('Maestría en Inteligencia Artificial'), 'maestria');
  assert.equal(nivelDelPrograma('Master of Science in Engineering'), 'maestria');
  assert.equal(nivelDelPrograma('Curso de Hacking Ético'), null, 'un curso no tiene nivel de postulación');
  assert.equal(nivelDelPrograma(''), null);
  assert.equal(nivelDelPrograma(null), null);
});

test('EL PUNTO: cada nivel guarda en SU campo, no en el del otro', async () => {
  reset();
  const mae: any = await registrarDocumentoAcademico({ dealId: 900, programa: 'Maestría en Psicología', ...IMG }, auth);
  assert.equal(mae.ok, true);
  assert.equal(campoEscrito(), config.ufTituloUniversitario, 'maestría → título universitario');
  assert.equal(mae.documento, DOCUMENTO_DE.maestria);

  reset();
  const lic: any = await registrarDocumentoAcademico({ dealId: 901, programa: 'Licenciatura en Psicología', ...IMG }, auth);
  assert.equal(campoEscrito(), config.ufDiplomaSecundaria, 'licenciatura → diploma de secundaria');
  assert.equal(lic.documento, DOCUMENTO_DE.licenciatura);

  assert.notEqual(config.ufTituloUniversitario, config.ufDiplomaSecundaria, 'son campos distintos');
});

test('NUNCA se guarda en el campo de la cédula', async () => {
  // Son documentos distintos, los revisa gente distinta, y cruzarlos obliga a pedirlos de nuevo.
  reset();
  await registrarDocumentoAcademico({ dealId: 902, programa: 'Maestría en Ingeniería', ...IMG }, auth);
  assert.notEqual(campoEscrito(), config.ufCedula);
  assert.equal(Object.keys(escrituras[0].fields).length, 1, 'escribe un solo campo');
});

test('sin programa en la ficha no se adivina dónde archivarlo', async () => {
  // De eso depende qué documento corresponde: guardarlo en el campo equivocado es peor que pedirlo
  // de nuevo, porque queda archivado como si el requisito estuviera cumplido.
  reset();
  const r: any = await registrarDocumentoAcademico({ dealId: 903, programa: '', ...IMG }, auth);
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'sin_programa');
  assert.equal(escrituras.length, 0, 'no escribe nada');
});

test('un curso de educación continua no tiene documento de postulación', async () => {
  reset();
  const r: any = await registrarDocumentoAcademico({ dealId: 904, programa: 'Hacking Ético', ...IMG }, auth);
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'sin_programa');
});

test('sin negociación no se guarda en ninguna parte', async () => {
  reset();
  const r: any = await registrarDocumentoAcademico({ programa: 'Maestría en Psicología', ...IMG }, auth);
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'sin_deal');
  assert.equal(escrituras.length, 0);
});

test('si Bitrix rechaza la escritura NO se da por recibido', async () => {
  // Marcar como recibido algo que no se guardó es el peor desenlace: nadie lo vuelve a pedir y la
  // matrícula se traba semanas después.
  reset();
  falla = true;
  const r: any = await registrarDocumentoAcademico({ dealId: 905, programa: 'Maestría en Psicología', ...IMG }, auth);
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'fallo_guardado');
});

test('el nombre del archivo dice qué es y de qué negociación', async () => {
  reset();
  await registrarDocumentoAcademico({ dealId: 906, programa: 'Licenciatura en Psicología', ...IMG }, auth);
  const [nombre] = escrituras[0].fields[config.ufDiplomaSecundaria].fileData;
  assert.match(nombre, /^diploma-secundaria-deal-906\.jpg$/);

  reset();
  await registrarDocumentoAcademico({ dealId: 907, programa: 'Maestría en Psicología', base64: 'eA==', mediaType: 'application/pdf' }, auth);
  const [nombrePdf] = escrituras[0].fields[config.ufTituloUniversitario].fileData;
  assert.match(nombrePdf, /^titulo-universitario-deal-907\.pdf$/, 'también acepta PDF, no solo fotos');
});
