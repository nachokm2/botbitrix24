import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Ficha de matrícula de Carver: los 14 antecedentes que antes pedía el formulario de postulación de
// cada asesor. Acá se escriben datos personales en una ficha real, así que las dos reglas que
// importan son: solo se guarda lo que la persona ENTREGÓ, y la etapa "Pendiente de Firma" se mueve
// únicamente con la ficha completa —foto de la cédula incluida—, porque una etapa que dice
// "pendiente de firma" sin antecedentes hace creer a quien la vea en el embudo que puede seguir.
process.env.MARCA = 'carver';
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

const llamadas: Array<{ method: string; params: any }> = [];
let contacto: Record<string, any> = {};
let deal: Record<string, any> = {};
let fallaEscritura = false;

async function crm(method: string, params: any) {
  llamadas.push({ method, params });
  if (method === 'crm.contact.get') return contacto;
  if (method === 'crm.contact.fields')
    return {
      UF_CRM_6564DCF2B858C: {
        type: 'enumeration',
        items: [
          { ID: '601', VALUE: 'Chile' },
          { ID: '4295', VALUE: 'Perú' },
          { ID: '8345', VALUE: 'Colombia' },
          { ID: '4299', VALUE: 'Ecuador' },
          { ID: '605', VALUE: 'Otros' },
        ],
      },
    };
  if (method === 'crm.deal.get') return deal;
  if (method === 'crm.contact.update') {
    if (fallaEscritura) throw new Error('Bitrix no responde (simulado)');
    Object.assign(contacto, params.fields);
    return true;
  }
  if (method === 'crm.deal.update') {
    Object.assign(deal, params.fields);
    return true;
  }
  return {};
}
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callCrm: crm,
    callBitrix: crm,
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: [] }),
    callWebhook: async () => ({}),
  },
});
mock.module('../src/obs/audit.ts', { namedExports: { audit: async () => {} } });

const { registrarDatosMatricula, moverAPendienteDeFirma } = await import('../src/crm/matricula');
const { config } = await import('../src/config');
const auth = { domain: 'test.bitrix24.com', access_token: 'tok' } as any;

function reset() {
  llamadas.length = 0;
  contacto = {};
  deal = {};
  fallaEscritura = false;
}
const update = () => llamadas.find((c) => c.method === 'crm.contact.update')?.params.fields ?? {};

const COMPLETA = {
  nombres: 'Pedro Andrés',
  apellidoPaterno: 'Soto',
  apellidoMaterno: 'Luna',
  dni: '12345678-9',
  nacionalidad: 'chilena',
  fechaNacimiento: '12/03/1990',
  domicilio: 'Av. Siempre Viva 742',
  celular: '+56912345678',
  emailPersonal: 'pedro@ejemplo.cl',
  tituloGrado: 'Ingeniero Comercial',
  institucionTitulo: 'Universidad de Chile',
  anioTitulo: '2015',
  codigoPostal: '7500000',
};

test('los dos apellidos van juntos en LAST_NAME', () => {
  // Bitrix no tiene campo para el segundo apellido: SECOND_NAME es "segundo nombre", que es otra
  // cosa, y meterlo ahí deja el dato donde nadie lo va a buscar.
  reset();
  return registrarDatosMatricula({ nombres: 'Pedro Andrés', apellidoPaterno: 'Soto', apellidoMaterno: 'Luna' }, { contact: 50 }, auth).then(() => {
    assert.equal(update().LAST_NAME, 'Soto Luna');
    assert.equal(update().NAME, 'Pedro Andrés');
    assert.equal(update().SECOND_NAME, undefined, 'no se usa el campo de segundo nombre');
  });
});

test('guarda lo parcial y dice exactamente qué falta', async () => {
  reset();
  const r = await registrarDatosMatricula({ nombres: 'Pedro', apellidoPaterno: 'Soto', dni: '12345678-9' }, { contact: 50 }, auth);
  assert.equal(r.ok, true);
  assert.equal(r.completo, false);
  assert.ok(r.guardados.includes('cédula o DNI'));
  assert.ok(r.faltan.includes('nacionalidad'), 'lo que no entregó sigue faltando');
  assert.ok(r.faltan.includes('foto de su cédula o DNI'));
  assert.ok(!r.faltan.includes('nombres'), 'lo que ya entregó no se vuelve a pedir');
});

test('un dato que ya está en la ficha no se vuelve a pedir', async () => {
  reset();
  contacto = { NAME: 'Pedro', LAST_NAME: 'Soto Luna', ADDRESS: 'Av. Siempre Viva 742' };
  const r = await registrarDatosMatricula({ dni: '12345678-9' }, { contact: 50 }, auth);
  for (const ya of ['nombres', 'apellido paterno', 'apellido materno', 'domicilio particular']) {
    assert.ok(!r.faltan.includes(ya), `${ya} ya estaba en la ficha`);
  }
});

test('un solo apellido en la ficha no da por entregado el materno', async () => {
  reset();
  contacto = { LAST_NAME: 'Soto' };
  const r = await registrarDatosMatricula({}, { contact: 50 }, auth);
  assert.ok(r.faltan.includes('apellido materno'));
  assert.ok(!r.faltan.includes('apellido paterno'));
});

test('la fecha se acepta como la escribe la gente, y si no se entiende se vuelve a pedir', async () => {
  reset();
  await registrarDatosMatricula({ fechaNacimiento: '12/03/1990' }, { contact: 50 }, auth);
  assert.equal(update().BIRTHDATE, '1990-03-12', 'dd/mm/aaaa');

  reset();
  await registrarDatosMatricula({ fechaNacimiento: '1990-3-5' }, { contact: 50 }, auth);
  assert.equal(update().BIRTHDATE, '1990-03-05');

  reset();
  const r = await registrarDatosMatricula({ fechaNacimiento: 'el 12 de marzo' }, { contact: 50 }, auth);
  assert.equal(update().BIRTHDATE, undefined, 'una fecha que no se entiende NO se inventa');
  assert.ok(r.faltan.includes('fecha de nacimiento'));
  assert.match(r.nota, /No entendí/);
});

test('del año de título se toma solo el año', async () => {
  reset();
  await registrarDatosMatricula({ anioTitulo: 'lo saqué el 2015' }, { contact: 50 }, auth);
  assert.equal(update()[config.ufAnioTitulo], '2015-12-31');
});

test('los campos personalizados van a los del portal, no a cualquiera', async () => {
  reset();
  await registrarDatosMatricula(COMPLETA, { contact: 50 }, auth);
  const f = update();
  assert.equal(f[config.ufDni], '12345678-9');
  assert.equal(f[config.ufTituloGrado], 'Ingeniero Comercial');
  assert.equal(f[config.ufInstitucionTitulo], 'Universidad de Chile');
  assert.equal(f.ADDRESS_POSTAL_CODE, '7500000');
  assert.deepEqual(f.PHONE, [{ VALUE: '+56912345678', VALUE_TYPE: 'MOBILE' }]);
  assert.deepEqual(f.EMAIL, [{ VALUE: 'pedro@ejemplo.cl', VALUE_TYPE: 'HOME' }]);
});

test('faltando los documentos, la ficha NO está completa aunque estén los 13 datos', async () => {
  // Los dos son obligatorios: sin ellos la matrícula no puede seguir de todos modos.
  reset();
  const r = await registrarDatosMatricula(COMPLETA, { contact: 50 }, auth);
  assert.equal(r.completo, false);
  assert.deepEqual(r.faltan, ['foto de su cédula o DNI', 'documento académico (diploma o título)']);
});

test('se nombra el documento académico que corresponde al nivel, no uno genérico', async () => {
  // Pedir "un documento académico" deja a la persona adivinando cuál de los dos.
  reset();
  const r = await registrarDatosMatricula(COMPLETA, { contact: 50 }, auth, {
    tieneFotoCedula: true,
    documentoQueCorresponde: 'título profesional o grado académico',
  });
  assert.deepEqual(r.faltan, ['título profesional o grado académico']);
});

test('con los 13 datos Y los dos documentos, la ficha queda completa', async () => {
  reset();
  const r = await registrarDatosMatricula(COMPLETA, { contact: 50 }, auth, {
    tieneFotoCedula: true,
    tieneDocumentoAcademico: true,
  });
  assert.equal(r.completo, true);
  assert.deepEqual(r.faltan, []);
  assert.match(r.nota, /instrucciones de pago/);
});

test('sin contacto no se escribe nada ni se promete haberlo guardado', async () => {
  reset();
  const r = await registrarDatosMatricula(COMPLETA, {}, auth);
  assert.equal(r.ok, false);
  assert.equal(llamadas.length, 0, 'ni siquiera consulta a Bitrix');
});

test('si Bitrix rechaza la escritura NO se dice que se guardó', async () => {
  reset();
  fallaEscritura = true;
  const r = await registrarDatosMatricula(COMPLETA, { contact: 50 }, auth, { tieneFotoCedula: true, tieneDocumentoAcademico: true });
  assert.equal(r.ok, false);
  assert.equal(r.completo, false, 'una escritura fallida no completa nada');
  assert.deepEqual(r.guardados, [], 'no puede decir que guardó algo');
});

// ── Pendiente de Firma ───────────────────────────────────────────────────────────────────────────
test('cada embudo tiene SU etapa de Pendiente de Firma', async () => {
  // En el 135 el identificador C135:EXECUTING es "Info Urgente", no "Pendiente de Firma": una etapa
  // fija mandaría media matrícula a la etapa equivocada.
  reset();
  deal = { CATEGORY_ID: '73', STAGE_ID: 'C73:UC_KY8NN7', CLOSED: 'N' };
  assert.equal(await moverAPendienteDeFirma(9001, auth), true);
  assert.equal(deal.STAGE_ID, 'C73:EXECUTING');

  reset();
  deal = { CATEGORY_ID: '135', STAGE_ID: 'C135:NEW', CLOSED: 'N' };
  assert.equal(await moverAPendienteDeFirma(9002, auth), true);
  assert.equal(deal.STAGE_ID, 'C135:1');
});

test('no se mueve una negociación de otro embudo, ni una ya cerrada', async () => {
  reset();
  deal = { CATEGORY_ID: '1', STAGE_ID: 'C1:NEW', CLOSED: 'N' };
  assert.equal(await moverAPendienteDeFirma(9003, auth), false, 'embudo sin etapa configurada');

  reset();
  deal = { CATEGORY_ID: '73', STAGE_ID: 'C73:WON', CLOSED: 'Y' };
  assert.equal(await moverAPendienteDeFirma(9004, auth), false, 'ya matriculado: no se reabre desde el chat');
  assert.equal(deal.STAGE_ID, 'C73:WON');

  reset();
  deal = { CATEGORY_ID: '73', STAGE_ID: 'C73:EXECUTING', CLOSED: 'N' };
  assert.equal(await moverAPendienteDeFirma(9005, auth), false, 'ya está ahí: no se ensucia el historial');
});

// ── Nacionalidad: es un desplegable, no texto libre ──────────────────────────────────────────────
test('la nacionalidad se traduce al valor del desplegable, aunque la digan como gentilicio', async () => {
  for (const [dicho, id] of [
    ['Chile', '601'],
    ['chilena', '601'],
    ['chileno', '601'],
    ['peruano', '4295'],
    ['Perú', '4295'],
    ['peru', '4295'],
    ['colombiana', '8345'],
    ['ecuatoriano', '4299'],
  ] as const) {
    reset();
    await registrarDatosMatricula({ nacionalidad: dicho }, { contact: 50 }, auth);
    assert.equal(update()[config.ufNacionalidad], id, `"${dicho}"`);
  }
});

test('un país que no está en la lista cae en "Otros" en vez de trabar la ficha', async () => {
  // República Dominicana es uno de los cinco mercados de Carver y NO está en el desplegable. Dejar
  // la ficha incompleta por eso sería peor: no podría matricularse nadie de ese país.
  reset();
  const r = await registrarDatosMatricula({ nacionalidad: 'dominicano' }, { contact: 50 }, auth);
  assert.equal(update()[config.ufNacionalidad], '605', 'Otros');
  assert.ok(!r.faltan.includes('nacionalidad'), 'queda entregada, no pendiente');
});
