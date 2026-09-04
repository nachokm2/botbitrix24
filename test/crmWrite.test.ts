import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';

// Test de integración de la escritura al CRM (actualizarDatosCliente). Mockea el cliente Bitrix
// (../src/bitrix/client) para capturar los métodos REST invocados y sus payloads, SIN tocar la red.
// Verifica la fusión de multicampos: agregar un email nuevo NO debe borrar el existente.
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';
process.env.BITRIX_UF_PROGRAMA = 'UF_CRM_PROGRAMA_TEST';
process.env.BITRIX_UF_BROCHURE_FILE = 'UF_CRM_BROCHURE_TEST';
process.env.BITRIX_UF_BROCHURE_FILE_2 = 'UF_CRM_BROCHURE_TEST_2';
process.env.BITRIX_UF_CUERPO_BROCHURE_HTML = 'UF_CRM_CUERPO_TEST';
process.env.BITRIX_DRIVE_FOLDER_MAGISTER = '111';
process.env.BITRIX_DRIVE_FOLDER_DIPLOMADO = '222';
process.env.BITRIX_DRIVE_FOLDER_ESPECIALIDAD = '333';
process.env.BITRIX_BIZPROC_TEMPLATE_BROCHURE = '77';

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

// asignarAsesorPorTurno se llama fire-and-forget (void) en cuanto el deal tiene programa — se mockea
// para poder verificar que SE LLAMA (con motivo='automatico'), sin repetir toda la lógica de turnos
// (ya cubierta en asignacionAsesores.test.ts).
type AsignacionCall = { entities: any; motivo: string };
const asignacionCalls: AsignacionCall[] = [];
mock.module('../src/crm/asignacionAsesores.ts', {
  namedExports: {
    asignarAsesorPorTurno: async (entities: any, _auth: any, motivo = 'escalado') => {
      asignacionCalls.push({ entities, motivo });
      return false;
    },
  },
});

// buscarBrochureDrive descarga el contenido con fetch() directo (la URL ya trae el token de
// Bitrix) — se mockea el global para simular esa descarga sin tocar la red. Se usa un PDF real
// (mínimo, generado con pdf-lib) porque fusionarBrochures necesita poder parsearlo cuando hay
// más de un programa acumulado.
const pdfDoc = await PDFDocument.create();
pdfDoc.addPage([50, 50]);
const PDF_FIXTURE = Buffer.from(await pdfDoc.save());

const realFetch = globalThis.fetch;
(globalThis as any).fetch = async (url: string) => {
  if (String(url).startsWith('http://descarga.test/')) {
    return { ok: true, arrayBuffer: async () => PDF_FIXTURE.buffer.slice(PDF_FIXTURE.byteOffset, PDF_FIXTURE.byteOffset + PDF_FIXTURE.byteLength) } as any;
  }
  return realFetch(url as any);
};

const { actualizarDatosCliente, capturaDeDatosEnCurso, ensureLeadForChat, crearNegociacionDesde } = await import('../src/crm/crmWrite');
const { obtenerVinculoChat, guardarVinculoChat } = await import('../src/crm/chat');

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

test('actualizarDatosCliente: registra profesión y dirección en la nota (antecedentes de postulación)', async () => {
  calls.length = 0;
  responder = () => ({});

  await actualizarDatosCliente({ contact: 8 }, undefined, { profesion: 'Trabajadora social', direccion: 'Av. Siempre Viva 123' }, auth);

  const nota = calls.find((c) => c.method === 'crm.timeline.comment.add');
  assert.ok(nota, 'deja una nota en el timeline');
  assert.match(nota!.params.fields.COMMENT, /Profesión: Trabajadora social/);
  assert.match(nota!.params.fields.COMMENT, /Dirección: Av\. Siempre Viva 123/);
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

// Responder reutilizable: 1 solo archivo en la carpeta de Magíster (folder 111 → file 2).
function responderUnSoloPrograma() {
  return (method: string, params: any) => {
    if (method === 'disk.folder.getchildren' && Number(params.id) === 111) {
      return [{ TYPE: 'file', NAME: 'Magíster - Inteligencia Artificial.pdf', ID: 2 }];
    }
    if (method === 'disk.file.get' && Number(params.id) === 2) {
      return { NAME: 'Magíster - Inteligencia Artificial.pdf', DOWNLOAD_URL: 'http://descarga.test/2' };
    }
    return {}; // crm.deal.get (obtenerTelefonoAsesor) → sin ASSIGNED_BY_ID, sin user.get
  };
}

test('actualizarDatosCliente: busca el brochure en el Drive, lo descarga y lo guarda con el programa de interés', async () => {
  calls.length = 0;
  responder = responderUnSoloPrograma();

  await actualizarDatosCliente({ deal: 42 }, undefined, { programa_interes: 'Magíster en Inteligencia Artificial' }, auth);

  const listado = calls.find((c) => c.method === 'disk.folder.getchildren');
  assert.ok(listado, 'lista la carpeta del Drive');
  assert.equal(listado!.params.id, 111, 'usa la carpeta de Magíster (BITRIX_DRIVE_FOLDER_MAGISTER)');
  assert.ok(calls.find((c) => c.method === 'disk.file.get' && c.params.id === 2), 'descarga el archivo correcto');

  const update = calls.find((c) => c.method === 'crm.deal.update');
  assert.ok(update, 'actualiza el deal');
  assert.equal(update!.params.fields.UF_CRM_PROGRAMA_TEST, 'Magíster en Inteligencia Artificial');
  const fileData = update!.params.fields.UF_CRM_BROCHURE_TEST?.fileData;
  assert.equal(fileData?.[0], 'Magíster - Inteligencia Artificial.pdf');
  assert.deepEqual(Buffer.from(fileData?.[1], 'base64'), PDF_FIXTURE, 'con un solo programa no se re-fusiona, se sube tal cual');

  const cuerpo = update!.params.fields.UF_CRM_CUERPO_TEST;
  assert.match(cuerpo, /Magíster en Inteligencia Artificial/);
  assert.match(cuerpo, /Programa de interés/, 'singular cuando hay un solo programa');
});

test('actualizarDatosCliente: apenas el deal tiene programa de interés, asigna al asesor por turno (motivo="automatico")', async () => {
  calls.length = 0;
  asignacionCalls.length = 0;
  responder = responderUnSoloPrograma();

  await actualizarDatosCliente({ deal: 63 }, undefined, { programa_interes: 'Magíster en Inteligencia Artificial' }, auth);

  assert.equal(asignacionCalls.length, 1, 'antes esto NUNCA se llamaba hasta que el bot escalaba — el deal quedaba con el responsable por defecto');
  assert.equal(asignacionCalls[0].entities.deal, 63);
  assert.equal(asignacionCalls[0].motivo, 'automatico');
});

test('actualizarDatosCliente: sin programa_interes en el input, no dispara la asignación automática', async () => {
  calls.length = 0;
  asignacionCalls.length = 0;
  responder = () => ({});

  await actualizarDatosCliente({ deal: 64 }, undefined, { telefono: '+56911112222' }, auth);

  assert.equal(asignacionCalls.length, 0);
});

test('actualizarDatosCliente: no vuelve a descargar el brochure si el programa no cambió', async () => {
  calls.length = 0;
  responder = responderUnSoloPrograma();
  await actualizarDatosCliente({ deal: 44 }, undefined, { programa_interes: 'Magíster en Inteligencia Artificial' }, auth);

  calls.length = 0;
  await actualizarDatosCliente({ deal: 44 }, undefined, { programa_interes: 'Magíster en Inteligencia Artificial' }, auth);

  assert.ok(!calls.find((c) => c.method === 'disk.folder.getchildren'), 'no relista el Drive la segunda vez');
  const update = calls.find((c) => c.method === 'crm.deal.update');
  assert.equal(update!.params.fields.UF_CRM_BROCHURE_TEST, undefined, 'no reenvía el brochure');
});

test('actualizarDatosCliente: dispara el bizproc de envío del brochure tras adjuntarlo', async () => {
  calls.length = 0;
  responder = responderUnSoloPrograma();

  await actualizarDatosCliente({ deal: 45 }, undefined, { programa_interes: 'Magíster en Inteligencia Artificial' }, auth);

  const update = calls.find((c) => c.method === 'crm.deal.update');
  const start = calls.find((c) => c.method === 'bizproc.workflow.start');
  assert.ok(start, 'dispara el workflow');
  assert.equal(start!.params.TEMPLATE_ID, '77');
  assert.deepEqual(start!.params.DOCUMENT_ID, ['crm', 'CCrmDocumentDeal', 'DEAL_45']);
  assert.ok(
    calls.indexOf(update!) < calls.indexOf(start!),
    'el workflow se dispara DESPUÉS de guardar el brochure en el deal (para que lo lea actualizado)',
  );
});

test('actualizarDatosCliente: no vuelve a disparar el bizproc si el programa no cambió', async () => {
  calls.length = 0;
  responder = responderUnSoloPrograma();
  await actualizarDatosCliente({ deal: 46 }, undefined, { programa_interes: 'Magíster en Inteligencia Artificial' }, auth);

  calls.length = 0;
  await actualizarDatosCliente({ deal: 46 }, undefined, { programa_interes: 'Magíster en Inteligencia Artificial' }, auth);

  assert.ok(!calls.find((c) => c.method === 'bizproc.workflow.start'), 'no vuelve a disparar el envío');
});

// Responder reutilizable para varios programas: 1 archivo por carpeta/folder id.
function responderVariosProgramas() {
  const archivos: Record<number, { NAME: string; ID: number }> = {
    111: { NAME: 'Magíster - Inteligencia Artificial.pdf', ID: 2 },
    222: { NAME: 'Diplomado - Big Data and Machine Learning.pdf', ID: 5 },
  };
  const porId: Record<number, string> = { 2: archivos[111].NAME, 5: archivos[222].NAME };
  return (method: string, params: any) => {
    if (method === 'disk.folder.getchildren' && archivos[Number(params.id)]) {
      return [{ TYPE: 'file', NAME: archivos[Number(params.id)].NAME, ID: archivos[Number(params.id)].ID }];
    }
    if (method === 'disk.file.get' && porId[Number(params.id)]) {
      return { NAME: porId[Number(params.id)], DOWNLOAD_URL: `http://descarga.test/${params.id}` };
    }
    return {};
  };
}

test('actualizarDatosCliente: acumula varios programas — cada uno en su propio archivo adjunto', async () => {
  calls.length = 0;
  responder = responderVariosProgramas();

  // Primer programa: como cualquier caso de un solo programa.
  await actualizarDatosCliente({ deal: 47 }, undefined, { programa_interes: 'Magíster en Inteligencia Artificial' }, auth);

  calls.length = 0;
  // Segundo programa, distinto: debe re-descargar AMBOS (el acumulado + el nuevo) y mandarlos como
  // DOS archivos separados (uno por slot), no fusionados, mientras haya slots disponibles.
  await actualizarDatosCliente(
    { deal: 47 },
    undefined,
    { programa_interes: 'Diplomado en Big Data and Machine Learning' },
    auth,
  );

  assert.ok(calls.find((c) => c.method === 'disk.file.get' && c.params.id === 2), 're-descarga el brochure ya acumulado');
  assert.ok(calls.find((c) => c.method === 'disk.file.get' && c.params.id === 5), 'descarga el brochure nuevo');

  const update = calls.find((c) => c.method === 'crm.deal.update');
  assert.ok(update, 'actualiza el deal');
  assert.equal(update!.params.fields.UF_CRM_BROCHURE_TEST?.fileData?.[0], 'Magíster - Inteligencia Artificial.pdf', 'slot 1 = primer programa');
  assert.equal(
    update!.params.fields.UF_CRM_BROCHURE_TEST_2?.fileData?.[0],
    'Diplomado - Big Data and Machine Learning.pdf',
    'slot 2 = segundo programa, en archivo SEPARADO (no fusionado)',
  );
  assert.equal(update!.params.fields.UF_CRM_BROCHURE_TEST_3, undefined, 'slot 3 no se toca (solo hay 2 programas)');

  const cuerpo = update!.params.fields.UF_CRM_CUERPO_TEST;
  assert.match(cuerpo, /Magíster en Inteligencia Artificial/, 'menciona el primer programa');
  assert.match(cuerpo, /Diplomado en Big Data and Machine Learning/, 'menciona el segundo programa');
  assert.match(cuerpo, /Programas de interés/, 'plural cuando hay varios programas');

  assert.ok(calls.find((c) => c.method === 'bizproc.workflow.start'), 'dispara un correo nuevo con ambos programas');
});

test('actualizarDatosCliente: más programas que slots — los que sobran se fusionan en el último slot', async () => {
  calls.length = 0;
  const archivosPorFolder: Record<number, { NAME: string; ID: number }[]> = {
    111: [{ NAME: 'Magíster - Inteligencia Artificial.pdf', ID: 2 }],
    222: [{ NAME: 'Diplomado - Big Data and Machine Learning.pdf', ID: 5 }],
    333: [{ NAME: 'Especialidad - Rehabilitación Oral.pdf', ID: 9 }],
  };
  const nombrePorId: Record<number, string> = {};
  for (const lista of Object.values(archivosPorFolder)) for (const a of lista) nombrePorId[a.ID] = a.NAME;
  responder = (method, params) => {
    if (method === 'disk.folder.getchildren' && archivosPorFolder[Number(params.id)]) {
      return archivosPorFolder[Number(params.id)].map((a) => ({ TYPE: 'file', NAME: a.NAME, ID: a.ID }));
    }
    if (method === 'disk.file.get' && nombrePorId[Number(params.id)]) {
      return { NAME: nombrePorId[Number(params.id)], DOWNLOAD_URL: `http://descarga.test/${params.id}` };
    }
    return {};
  };

  // 1er programa: ocupa el slot 1, sin fusión.
  await actualizarDatosCliente({ deal: 48 }, undefined, { programa_interes: 'Magíster en Inteligencia Artificial' }, auth);

  calls.length = 0;
  // 2º programa: ocupa el slot 2 (último disponible, solo hay 2 slots configurados), sin fusión.
  await actualizarDatosCliente({ deal: 48 }, undefined, { programa_interes: 'Diplomado en Big Data and Machine Learning' }, auth);

  let update = calls.find((c) => c.method === 'crm.deal.update');
  assert.equal(update!.params.fields.UF_CRM_BROCHURE_TEST_2?.fileData?.[0], 'Diplomado - Big Data and Machine Learning.pdf');

  calls.length = 0;
  // 3er programa: ya no hay slot propio → se fusiona con el del último slot (el 2º).
  await actualizarDatosCliente({ deal: 48 }, undefined, { programa_interes: 'Especialidad en Rehabilitación Oral' }, auth);

  update = calls.find((c) => c.method === 'crm.deal.update');
  assert.ok(update, 'actualiza el deal');
  assert.equal(update!.params.fields.UF_CRM_BROCHURE_TEST?.fileData?.[0], 'Magíster - Inteligencia Artificial.pdf', 'slot 1 sigue con el 1º programa');
  const slot2 = update!.params.fields.UF_CRM_BROCHURE_TEST_2?.fileData;
  assert.equal(slot2?.[0], 'Brochures.pdf', 'el 2º y 3º programa se fusionan en el slot 2 (ya no hay slot propio)');
  const merged = await PDFDocument.load(Buffer.from(slot2?.[1], 'base64'));
  assert.equal(merged.getPageCount(), 2, 'el PDF fusionado del slot 2 tiene una página por cada brochure que le tocó');
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

test('ensureLeadForChat: crea el lead con crm.lead.add (no imopenlines.crm.lead.create) y guarda el vínculo del chat', async () => {
  calls.length = 0;
  responder = (method) => {
    if (method === 'crm.lead.add') return 4242;
    return {};
  };

  const entidad = await ensureLeadForChat('chat999', auth, { nombre: 'Ana' });

  assert.deepEqual(entidad, { type: 'lead', id: 4242 });
  const add = calls.find((c) => c.method === 'crm.lead.add');
  assert.ok(add, 'crea el lead con crm.lead.add');
  assert.equal(add!.params.fields.NAME, 'Ana');
  assert.ok(
    !calls.find((c) => c.method === 'imopenlines.crm.lead.create'),
    'ya no depende del método de Open Lines que falla con ERROR_USER_NOT_OPERATOR',
  );

  const vinculo = await obtenerVinculoChat('chat999');
  assert.deepEqual(vinculo, { type: 'lead', id: 4242 }, 'guarda el vínculo a mano, sin depender de CHAT_ENTITY_DATA_2');
});

test('actualizarDatosCliente: migra los datos del lead propio (incluido el programa) cuando Bitrix vincula un contacto+deal distintos después', async () => {
  calls.length = 0;
  asignacionCalls.length = 0;
  // Simula el estado dejado por ensureLeadForChat/el bloque LEAD en turnos anteriores: guardamos
  // el vínculo propio a un lead que ya tiene nombre+email+programa capturados (el lead no tiene UF
  // de programa, por eso se guarda acá).
  await guardarVinculoChat('chatMig', { type: 'lead', id: 555, programaInteres: 'Magíster en Inteligencia Artificial' });
  responder = (method, params) => {
    if (method === 'crm.lead.get') return { NAME: 'Rodrigo', EMAIL: [{ VALUE: 'rodrigo@correo.cl' }] };
    if (method === 'crm.contact.get') return { NAME: '', EMAIL: [], PHONE: [] }; // el contacto nuevo llega vacío
    if (method === 'crm.deal.get') return {}; // el deal nuevo llega sin programa
    return {};
  };

  // Ahora Bitrix ya vinculó su propio contacto+deal (3027577 / 3480399) a este chat.
  await actualizarDatosCliente({ contact: 3027577, deal: 3480399 }, 'chatMig', { telefono: '+56911112222' }, auth);

  const migracion = calls.find((c) => c.method === 'crm.contact.update' && c.params.id === 3027577 && c.params.fields.NAME);
  assert.ok(migracion, 'migra nombre/email del lead viejo al contacto nuevo');
  assert.equal(migracion!.params.fields.NAME, 'Rodrigo');
  assert.equal(migracion!.params.fields.EMAIL?.[0]?.VALUE, 'rodrigo@correo.cl');

  const migracionPrograma = calls.find(
    (c) => c.method === 'crm.deal.update' && c.params.id === 3480399 && c.params.fields.UF_CRM_PROGRAMA_TEST,
  );
  assert.ok(migracionPrograma, 'migra el programa de interés al deal nuevo');
  assert.equal(migracionPrograma!.params.fields.UF_CRM_PROGRAMA_TEST, 'Magíster en Inteligencia Artificial');

  const vinculo = await obtenerVinculoChat('chatMig');
  assert.equal(vinculo, null, 'borra el vínculo propio tras migrar (ya no hace falta)');

  assert.equal(asignacionCalls.length, 1, 'también asigna al asesor por turno cuando el deal recién obtiene el programa vía migración (no solo vía input directo)');
  assert.equal(asignacionCalls[0].entities.deal, 3480399);
  assert.equal(asignacionCalls[0].motivo, 'automatico');
});

test('actualizarDatosCliente: mueve el deal al embudo/etapa de Asignación correctos si quedó en el embudo equivocado', async () => {
  calls.length = 0;
  responder = (method) => {
    if (method === 'crm.deal.get') return { CATEGORY_ID: '1' }; // quedó en Diplomados (embudo equivocado)
    return {};
  };

  await actualizarDatosCliente({ deal: 50 }, undefined, { programa_interes: 'Magíster en Inteligencia Artificial' }, auth);

  const mover = calls.find(
    (c) => c.method === 'crm.deal.update' && c.params.id === 50 && c.params.fields.CATEGORY_ID !== undefined,
  );
  assert.ok(mover, 'mueve el deal al embudo correcto (Maestrías)');
  assert.equal(mover!.params.fields.CATEGORY_ID, 3);
  assert.equal(mover!.params.fields.STAGE_ID, 'C3:NEW');
});

test('actualizarDatosCliente: no toca la etapa si el deal ya está en el embudo correcto (no pisa el avance del asesor)', async () => {
  calls.length = 0;
  responder = (method) => {
    if (method === 'crm.deal.get') return { CATEGORY_ID: '3' }; // ya está en Maestrías
    return {};
  };

  await actualizarDatosCliente({ deal: 51 }, undefined, { programa_interes: 'Magíster en Inteligencia Artificial' }, auth);

  const mover = calls.find(
    (c) => c.method === 'crm.deal.update' && c.params.id === 51 && c.params.fields.CATEGORY_ID !== undefined,
  );
  assert.ok(!mover, 'no mueve nada: el embudo ya es el correcto');
});

test('actualizarDatosCliente: fuerza la etapa de Asignación una vez si el deal es reciente y nunca pasó por ahí (mismo embudo, otra etapa)', async () => {
  calls.length = 0;
  responder = (method) =>
    method === 'crm.deal.get' ? { CATEGORY_ID: '3', STAGE_ID: 'C3:PREPARATION', DATE_CREATE: new Date().toISOString() } : {};

  await actualizarDatosCliente({ deal: 60 }, undefined, { programa_interes: 'Magíster en Inteligencia Artificial' }, auth);

  const mover = calls.find((c) => c.method === 'crm.deal.update' && c.params.id === 60 && c.params.fields.STAGE_ID !== undefined);
  assert.ok(mover, 'fuerza la etapa de Asignación aunque el embudo ya era correcto (deal reciente)');
  assert.equal(mover!.params.fields.STAGE_ID, 'C3:NEW');
  assert.equal(mover!.params.fields.CATEGORY_ID, undefined, 'no toca CATEGORY_ID: el embudo ya era correcto');
});

test('actualizarDatosCliente: NO fuerza dos veces el mismo deal (no pisa el avance real de un asesor después de la primera pasada)', async () => {
  calls.length = 0;
  responder = (method) =>
    method === 'crm.deal.get' ? { CATEGORY_ID: '3', STAGE_ID: 'C3:PREPARATION', DATE_CREATE: new Date().toISOString() } : {};

  await actualizarDatosCliente({ deal: 61 }, undefined, { programa_interes: 'Magíster en Inteligencia Artificial' }, auth);
  calls.length = 0; // limpia para verificar solo la SEGUNDA pasada
  await actualizarDatosCliente({ deal: 61 }, undefined, { programa_interes: 'Magíster en Inteligencia Artificial' }, auth);

  const mover = calls.find((c) => c.method === 'crm.deal.update' && c.params.id === 61 && c.params.fields.STAGE_ID !== undefined);
  assert.ok(!mover, 'la segunda vez no vuelve a mover la etapa');
});

test('actualizarDatosCliente: NO fuerza la etapa de un deal viejo (probablemente un asesor ya lo movió a propósito)', async () => {
  calls.length = 0;
  responder = (method) =>
    method === 'crm.deal.get' ? { CATEGORY_ID: '3', STAGE_ID: 'C3:PREPARATION', DATE_CREATE: '2020-01-01T00:00:00+00:00' } : {};

  await actualizarDatosCliente({ deal: 62 }, undefined, { programa_interes: 'Magíster en Inteligencia Artificial' }, auth);

  const mover = calls.find((c) => c.method === 'crm.deal.update' && c.params.id === 62 && c.params.fields.STAGE_ID !== undefined);
  assert.ok(!mover, 'no toca un deal viejo, aunque nunca haya pasado por Asignación');
});

test('capturaDeDatosEnCurso: nombre+email guardados pero sin teléfono → captura a medias (true)', async () => {
  calls.length = 0;
  responder = (method) => {
    if (method === 'crm.contact.get') return { NAME: 'Rodrigo', EMAIL: [{ VALUE: 'r@x.cl' }], PHONE: [] };
    return {};
  };
  const enCurso = await capturaDeDatosEnCurso({ contact: 1 }, auth);
  assert.equal(enCurso, true);
});

test('capturaDeDatosEnCurso: sin ningún dato capturado → no bloquea (false)', async () => {
  calls.length = 0;
  responder = (method) => {
    if (method === 'crm.contact.get') return { NAME: '', EMAIL: [], PHONE: [] };
    return {};
  };
  const enCurso = await capturaDeDatosEnCurso({ contact: 1 }, auth);
  assert.equal(enCurso, false);
});

test('capturaDeDatosEnCurso: los 3 datos ya guardados → no bloquea (false)', async () => {
  calls.length = 0;
  responder = (method) => {
    if (method === 'crm.contact.get') return { NAME: 'Rodrigo', EMAIL: [{ VALUE: 'r@x.cl' }], PHONE: [{ VALUE: '+56911112222' }] };
    return {};
  };
  const enCurso = await capturaDeDatosEnCurso({ contact: 1 }, auth);
  assert.equal(enCurso, false);
});

test('crearNegociacionDesde: crea contacto + negociación directo (sin lead) en el embudo de Diplomados', async () => {
  calls.length = 0;
  responder = (method) => {
    if (method === 'crm.contact.add') return 9001;
    if (method === 'crm.deal.add') return 9002;
    return {};
  };

  const fuente = { sourceId: 'WEB', tituloPrefijo: 'Web', tituloGenerico: 'Consulta web', label: 'web' };
  const r = await crearNegociacionDesde(
    {
      nombre: 'Camila',
      apellido: 'Rojas',
      email: 'camila@correo.cl',
      telefono: '+56933334444',
      programa_interes: 'Diplomado en Intervención Terapéutica Familiar',
    },
    auth,
    fuente,
  );

  assert.deepEqual(r, { contact: 9001, deal: 9002 });
  const contactAdd = calls.find((c) => c.method === 'crm.contact.add');
  assert.equal(contactAdd!.params.fields.NAME, 'Camila');
  assert.equal(contactAdd!.params.fields.PHONE[0].VALUE, '+56933334444');
  const dealAdd = calls.find((c) => c.method === 'crm.deal.add');
  assert.ok(dealAdd, 'crea la negociación');
  assert.equal(dealAdd!.params.fields.CONTACT_ID, 9001);
  assert.equal(dealAdd!.params.fields.CATEGORY_ID, 1, 'embudo de Diplomados');
  assert.equal(dealAdd!.params.fields.STAGE_ID, 'C1:NEW');
  assert.equal(dealAdd!.params.fields.UF_CRM_PROGRAMA_TEST, 'Diplomado en Intervención Terapéutica Familiar');
  assert.ok(!calls.find((c) => c.method === 'crm.lead.add'), 'no crea un lead intermedio');
});

test('crearNegociacionDesde: usa el embudo de Magíster cuando corresponde', async () => {
  calls.length = 0;
  responder = (method) => {
    if (method === 'crm.contact.add') return 9101;
    if (method === 'crm.deal.add') return 9102;
    return {};
  };

  const fuente = { sourceId: 'WEB', tituloPrefijo: 'Web', tituloGenerico: 'Consulta web', label: 'web' };
  await crearNegociacionDesde(
    { nombre: 'Matías', telefono: '+56944445555', programa_interes: 'Magíster en Inteligencia Artificial' },
    auth,
    fuente,
  );

  const dealAdd = calls.find((c) => c.method === 'crm.deal.add');
  assert.equal(dealAdd!.params.fields.CATEGORY_ID, 3, 'embudo de Maestrías');
  assert.equal(dealAdd!.params.fields.STAGE_ID, 'C3:NEW');
});
