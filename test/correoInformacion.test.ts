import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// La información del programa al correo de la persona (Carver). El bot decía "le envío el detalle al
// correo que tenemos registrado" sin poder enviar nada (chat 1583541, 07-11-2026). Lo delicado no es
// enviarlo sino QUÉ dice: un correo queda por escrito, así que cada cifra sale de la planilla validada
// y cada fecha del calendario del panel, nunca del modelo.
process.env.MARCA = 'carver';
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.BITRIX_EMBUDOS_PROPIOS = '73,135,107';
process.env.BITRIX_BIZPROC_TEMPLATE_CORREO_INFO = '9999';
process.env.BITRIX_UF_CORREO_INFO_CUERPO = 'UF_CRM_CUERPO_TEST';
process.env.BITRIX_UF_CORREO_INFO_ADJUNTO = 'UF_CRM_ADJUNTO_TEST';

const PDF = Buffer.from('%PDF-1.4\n% brochure de prueba\n');

let deal: any;
let contacto: any;
let llamadas: Array<{ method: string; params: any }> = [];
let quitarAdjuntoFunciona = true;
let archivosDrive: any[] = [];

mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callCrm: async (method: string, params: any) => {
      llamadas.push({ method, params });
      if (method === 'crm.deal.get') return deal;
      if (method === 'crm.contact.get') return contacto;
      if (method === 'crm.deal.update') {
        const adj = params.fields?.UF_CRM_ADJUNTO_TEST;
        if (adj?.del === 'Y' && quitarAdjuntoFunciona) deal = { ...deal, UF_CRM_ADJUNTO_TEST: null };
        if (adj?.fileData) deal = { ...deal, UF_CRM_ADJUNTO_TEST: { id: 555 } };
        return true;
      }
      if (method === 'bizproc.workflow.start') return 'wf-1';
      if (method === 'disk.file.get') return { ID: params.id, DOWNLOAD_URL: `https://portal.test/descarga/${params.id}` };
      if (method === 'user.get') return [];
      return {};
    },
    callBitrix: async () => ({}),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async (method: string) => (method === 'disk.folder.getchildren' ? { result: archivosDrive } : { result: [] }),
    callWebhook: async () => ({}),
  },
});

const fetchOriginal = globalThis.fetch;
globalThis.fetch = (async (url: any) => {
  if (String(url).startsWith('https://portal.test/descarga/')) {
    return new Response(PDF, { status: 200, headers: { 'content-type': 'application/pdf' } });
  }
  return fetchOriginal(url);
}) as typeof fetch;

const m = await import('../src/crm/correoInformacion');
const { promesaDeCorreo } = await import('../src/core/promesas');
const { matchProgramaCarver } = await import('../src/core/condicionesCarver');
const { _limpiarCacheBrochureArchivo } = await import('../src/core/brochureArchivo');
const { correoInformacionActivo } = await import('../src/crm/correoActivo');
const { WHATSAPP_PROFILE } = await import('../src/core/channel');
const { SYSTEM_PROMPT } = await import('../src/ai/prompt');
const auth = { domain: 'test.bitrix24.com', access_token: 'tok' } as any;

let dealSeq = 1000;
function reset(opts: { conBrochure?: boolean } = {}) {
  dealSeq += 1;
  deal = { ID: dealSeq, CATEGORY_ID: '73', CONTACT_ID: '77', ASSIGNED_BY_ID: '0' };
  contacto = { NAME: 'Ana', EMAIL: [{ VALUE: 'persona@yahoo.com', VALUE_TYPE: 'WORK' }] };
  llamadas = [];
  quitarAdjuntoFunciona = true;
  archivosDrive = opts.conBrochure === false ? [] : [{ ID: '2471837', NAME: 'L. Psicología - Carver University.pdf' }];
  _limpiarCacheBrochureArchivo();
}
const ents = () => ({ deal: dealSeq, contact: 77 });
const psicologia = () => matchProgramaCarver('Licenciatura en Psicología').find((p) => p.nombre === 'Licenciatura en Psicología')!;

test('el cuerpo trae las cifras de la planilla, tal como las cotiza el bot', () => {
  const t = m.cuerpoCorreoInformacion({
    nombre: 'Ana',
    programa: psicologia(),
    ingreso: { inicio: '2026-11-23', cierre: '2026-11-20' },
    conBrochure: true,
    asesor: { nombre: 'Asesora de Prueba', whatsapp: '+56912345678', email: 'asesora@carver.university' },
  });
  assert.match(t, /^Hola, Ana:/);
  assert.match(t, /Licenciatura en Psicología/);
  assert.match(t, /Arancel: USD 8\.000\. Con la Beca George Washington Carver Grant \(50 %\), queda en USD 4\.000\./);
  assert.match(t, /40 cuotas de USD 100, más una matrícula de USD 50 \(valor regular: USD 150\)/);
  assert.match(t, /Semestral: 8 pagos de USD 410 \(USD 3\.280 en total\), sin matrícula/);
  // El contado de una licenciatura se paga POR AÑO: dicho como un solo pago confundía a la gente.
  assert.match(t, /Contado: USD 585 al año durante 4 años \(USD 2\.340 en total\), sin matrícula/);
  assert.match(t, /Inicio de clases: lunes 23 de noviembre de 2026\./);
  assert.match(t, /Cierre de postulación: viernes 20 de noviembre de 2026\./);
  assert.match(t, /Le adjunto el brochure del programa\./);
  assert.match(t, /WhatsApp: \+56 9 1234 5678/);
  assert.match(t, /Correo: asesora@carver\.university/);
  assert.match(t, /Asesora de Prueba\nCarver University$/);
  // Texto plano: Bitrix escapa el HTML de los campos y los emojis truncan el campo.
  assert.doesNotMatch(t, /[<>]/);
  assert.doesNotMatch(t, /[\u{10000}-\u{10FFFF}]/u);
});

test('sin brochure, sin fechas y sin asesor no dice que hay adjunto ni inventa fechas', () => {
  const t = m.cuerpoCorreoInformacion({ nombre: '😀 ', programa: psicologia(), ingreso: null, conBrochure: false, asesor: null });
  assert.match(t, /^Hola:/); // un nombre que era solo un emoji no deja "Hola, :"
  assert.doesNotMatch(t, /adjunto/i);
  assert.doesNotMatch(t, /PRÓXIMO INGRESO/);
  assert.match(t, /escribirnos por WhatsApp/);
  assert.match(t, /Saludos cordiales,\nCarver University$/);
});

test('una maestría con contado único lo dice como un pago', () => {
  const p = matchProgramaCarver('Maestría en Psicología').find((x) => x.nombre === 'Maestría en Psicología')!;
  const t = m.cuerpoCorreoInformacion({ programa: p, conBrochure: false });
  assert.match(t, /Contado: un pago de USD 900, sin matrícula/);
  assert.match(t, /12 cuotas de USD 150/);
});

test('con cupos completos avisa la reapertura y no ofrece un ingreso', () => {
  const p = { ...psicologia(), cotizable: false, motivoNoCotizable: 'cupos completos', reabre: 'marzo de 2027' };
  const t = m.cuerpoCorreoInformacion({ programa: p, ingreso: { inicio: '2026-11-23' }, conBrochure: false });
  assert.match(t, /cupos completos y la matrícula reabre en marzo de 2027/);
  assert.doesNotMatch(t, /PRÓXIMO INGRESO/);
});

test('el próximo ingreso es el más cercano con la postulación abierta', () => {
  const cal = [
    { ciclo: 'C04', programa: 'todos', inicioClases: '2026-10-26', cierrePostulacion: '2026-10-23' },
    { ciclo: 'C05', programa: 'todos', inicioClases: '2026-11-23', cierrePostulacion: '2026-11-20' },
    { ciclo: 'C06', programa: 'todos', inicioClases: '2027-01-11', cierrePostulacion: '2027-01-08' },
    { ciclo: 'X1', programa: 'Maestría en Ingeniería', inicioClases: '2026-11-16', cierrePostulacion: '2026-11-13' },
  ];
  assert.deepEqual(m.proximoIngreso(cal, 'Licenciatura en Psicología', '2026-11-07'), { inicio: '2026-11-23', cierre: '2026-11-20' });
  // El ciclo propio de otro programa no se le ofrece a Psicología, pero sí a ese programa.
  assert.deepEqual(m.proximoIngreso(cal, 'Maestría en Ingeniería', '2026-11-07'), { inicio: '2026-11-16', cierre: '2026-11-13' });
  // Con la postulación del 20 cerrada, el siguiente.
  assert.deepEqual(m.proximoIngreso(cal, 'Licenciatura en Psicología', '2026-11-21'), { inicio: '2027-01-11', cierre: '2027-01-08' });
  assert.equal(m.proximoIngreso(cal, 'Licenciatura en Psicología', '2027-02-01'), null);
  assert.equal(m.fechaEnPalabras('2026-02-30'), '');
});

test('detecta el pedido de reenvío', () => {
  assert.equal(m.pideReenvio('No me llegó nada al correo'), true);
  assert.equal(m.pideReenvio('¿Me lo puede reenviar?'), true);
  assert.equal(m.pideReenvio('Gracias, ya lo recibí'), false);
});

test('la promesa de correo se detecta, la oferta y el dato del asesor no', () => {
  assert.ok(promesaDeCorreo('Le envío el detalle al correo que tenemos registrado. Quedo pendiente por acá.'));
  assert.ok(promesaDeCorreo('Perfecto, se lo hago llegar a su correo.'));
  assert.ok(promesaDeCorreo('Le llegará al mail en unos minutos.'));
  assert.equal(promesaDeCorreo('¿Quiere que se lo envíe al correo?'), null);
  assert.equal(promesaDeCorreo('Le comparto mi correo: asesora@carver.university'), null);
  assert.equal(promesaDeCorreo('Puede escribirme al correo cuando quiera.'), null);
});

test('envía: escribe el cuerpo y el PDF en la negociación y lanza la plantilla', async () => {
  reset();
  const r: any = await m.enviarInformacionPorCorreo('Licenciatura en Psicología', ents(), auth);
  assert.equal(r.ok, true);
  assert.equal(r.enviadoA, 'persona@yahoo.com');
  assert.equal(r.conBrochure, true);
  const update = llamadas.find((l) => l.method === 'crm.deal.update')!;
  assert.match(update.params.fields.UF_CRM_CUERPO_TEST, /40 cuotas de USD 100/);
  assert.equal(update.params.fields.UF_CRM_ADJUNTO_TEST.fileData[0], 'L. Psicología - Carver University.pdf');
  assert.equal(Buffer.from(update.params.fields.UF_CRM_ADJUNTO_TEST.fileData[1], 'base64').toString('latin1').slice(0, 5), '%PDF-');
  const wf = llamadas.find((l) => l.method === 'bizproc.workflow.start')!;
  assert.equal(wf.params.TEMPLATE_ID, '9999');
  assert.deepEqual(wf.params.DOCUMENT_ID, ['crm', 'CCrmDocumentDeal', `DEAL_${dealSeq}`]);
  // El campo se escribe ANTES de lanzar la plantilla, que lo lee.
  assert.ok(llamadas.indexOf(update) < llamadas.indexOf(wf));
  assert.equal(await m.correoEnviadoHace(dealSeq, 60), true);
});

test('no lo manda dos veces, salvo que diga que no le llegó', async () => {
  reset();
  await m.enviarInformacionPorCorreo('Licenciatura en Psicología', ents(), auth);
  llamadas = [];
  const r2: any = await m.enviarInformacionPorCorreo('Licenciatura en Psicología', ents(), auth, { ultimoMensajeCliente: 'Gracias' });
  assert.equal(r2.yaEnviado, true);
  assert.equal(llamadas.some((l) => l.method === 'bizproc.workflow.start'), false);
  const r3: any = await m.enviarInformacionPorCorreo('Licenciatura en Psicología', ents(), auth, { ultimoMensajeCliente: 'No me llegó nada' });
  assert.equal(r3.ok, true);
  assert.equal(r3.yaEnviado, undefined);
  assert.equal(llamadas.filter((l) => l.method === 'bizproc.workflow.start').length, 1);
});

test('como mucho tres correos al día por negociación', async () => {
  reset();
  for (let i = 0; i < 3; i++) {
    const r: any = await m.enviarInformacionPorCorreo('Licenciatura en Psicología', ents(), auth, { ultimoMensajeCliente: 'reenvíelo por favor' });
    assert.equal(r.ok, true, `envío ${i + 1}`);
  }
  const r4: any = await m.enviarInformacionPorCorreo('Licenciatura en Psicología', ents(), auth, { ultimoMensajeCliente: 'reenvíelo por favor' });
  assert.deepEqual([r4.ok, r4.motivo], [false, 'limite_diario']);
});

test('al modelo le llega el correo enmascarado, nunca la dirección completa', async () => {
  reset();
  const r: any = await m.enviarInformacionPorCorreo('Licenciatura en Psicología', ents(), auth);
  const paraModelo = JSON.stringify(m.resultadoParaElModelo(r));
  assert.doesNotMatch(paraModelo, /persona@/);
  assert.match(paraModelo, /p\*\*\*@yahoo\.com/);
  assert.match(paraModelo, /termina en @yahoo\.com/);
});

test('con dos correos en la ficha no envía solo: puede ir al viejo', async () => {
  reset();
  contacto = { NAME: 'Ana', EMAIL: [{ VALUE: 'viejo@hotmail.com' }, { VALUE: 'persona@yahoo.com' }] };
  const r: any = await m.enviarInformacionPorCorreo('Licenciatura en Psicología', ents(), auth);
  assert.deepEqual([r.ok, r.motivo], [false, 'varios_correos']);
  assert.equal(llamadas.some((l) => l.method === 'bizproc.workflow.start'), false);
  assert.equal(m.requiereAviso(r.motivo), true);
  // El mismo correo repetido con otras mayúsculas no cuenta como dos.
  reset();
  contacto = { NAME: 'Ana', EMAIL: [{ VALUE: 'persona@yahoo.com' }, { VALUE: 'PerSona@Yahoo.com ' }] };
  const r2: any = await m.enviarInformacionPorCorreo('Licenciatura en Psicología', ents(), auth);
  assert.equal(r2.ok, true);
});

test('si el correo que acaba de dar no es el de la ficha, espera a que se guarde', async () => {
  reset();
  contacto = { NAME: 'Ana', EMAIL: [{ VALUE: 'viejo@hotmail.com' }] };
  const r: any = await m.enviarInformacionPorCorreo('Licenciatura en Psicología', ents(), auth, { emailDado: 'persona@yahoo.com' });
  assert.deepEqual([r.ok, r.motivo], [false, 'correo_distinto']);
  assert.equal(llamadas.some((l) => l.method === 'bizproc.workflow.start'), false);
  assert.match(String(m.resultadoParaElModelo(r).nota), /registrar_interes_crm/);
  reset();
  const r2: any = await m.enviarInformacionPorCorreo('Licenciatura en Psicología', ents(), auth, { emailDado: ' PerSona@yahoo.com' });
  assert.equal(r2.ok, true);
});

test('sin correo en la ficha no envía y pide registrarlo', async () => {
  reset();
  contacto = { NAME: 'Ana', EMAIL: [] };
  const r: any = await m.enviarInformacionPorCorreo('Licenciatura en Psicología', ents(), auth);
  assert.deepEqual([r.ok, r.motivo], [false, 'sin_correo']);
  assert.equal(llamadas.some((l) => l.method === 'bizproc.workflow.start'), false);
  assert.match(String(m.resultadoParaElModelo(r).nota), /registrar_interes_crm/);
});

test('una negociación de otro embudo no se toca', async () => {
  reset();
  deal = { ...deal, CATEGORY_ID: '3' };
  const r: any = await m.enviarInformacionPorCorreo('Licenciatura en Psicología', ents(), auth);
  assert.deepEqual([r.ok, r.motivo], [false, 'embudo_ajeno']);
  assert.equal(llamadas.some((l) => l.method === 'crm.deal.update'), false);
});

test('un programa que no está en la planilla no se envía', async () => {
  reset();
  const r: any = await m.enviarInformacionPorCorreo('Doctorado en Astrofísica', ents(), auth);
  assert.deepEqual([r.ok, r.motivo], [false, 'programa_no_encontrado']);
  assert.equal(llamadas.length, 0);
});

test('sin brochure nuevo quita el de un envío anterior; si no puede, no envía', async () => {
  reset({ conBrochure: false });
  deal = { ...deal, UF_CRM_ADJUNTO_TEST: { id: 321 } };
  const r: any = await m.enviarInformacionPorCorreo('Licenciatura en Psicología', ents(), auth);
  assert.equal(r.ok, true);
  assert.equal(r.conBrochure, false);
  const update = llamadas.find((l) => l.method === 'crm.deal.update')!;
  assert.deepEqual(update.params.fields.UF_CRM_ADJUNTO_TEST, { id: 321, del: 'Y' });
  assert.doesNotMatch(update.params.fields.UF_CRM_CUERPO_TEST, /adjunto/i);

  reset({ conBrochure: false });
  deal = { ...deal, UF_CRM_ADJUNTO_TEST: { id: 321 } };
  quitarAdjuntoFunciona = false;
  const r2: any = await m.enviarInformacionPorCorreo('Licenciatura en Psicología', ents(), auth);
  assert.deepEqual([r2.ok, r2.motivo], [false, 'adjunto_no_se_pudo_quitar']);
  assert.equal(llamadas.some((l) => l.method === 'bizproc.workflow.start'), false);
  assert.equal(m.requiereAviso(r2.motivo), true);
});

test('con la plantilla configurada, el bot tiene la herramienta y la regla en el prompt', () => {
  assert.equal(correoInformacionActivo(), true);
  assert.ok(WHATSAPP_PROFILE.toolNames.includes('enviar_informacion_por_correo'));
  assert.match(SYSTEM_PROMPT, /INFORMACIÓN POR CORREO: cuando la persona pida/);
  assert.match(SYSTEM_PROMPT, /Explica que es para enviarle la información y darle seguimiento\./);
});
