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
process.env.CORREO_INFO_REMITENTE = 'Carver University <admissioncarver@carver.university>';

let deal: any;
let contacto: any;
let llamadas: Array<{ method: string; params: any }> = [];
let enviado = true;
let brochure: any = { ok: true, programa: 'Licenciatura en Psicología', url: 'https://portal.test/brochure-psicologia.pdf', formato: 'pdf' };

mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callCrm: async (method: string, params: any) => {
      llamadas.push({ method, params });
      if (method === 'crm.deal.get') return deal;
      if (method === 'crm.contact.get') return contacto;
      if (method === 'crm.activity.add') return 4242;
      if (method === 'crm.activity.get') return { ID: params.id, SETTINGS: { IS_MESSAGE_SENT: enviado } };
      if (method === 'user.get') return [];
      return {};
    },
    callBitrix: async () => ({}),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: [] }),
    callWebhook: async () => ({}),
  },
});
mock.module('../src/core/brochures.ts', {
  namedExports: {
    obtenerBrochure: async () => brochure,
    archivoCorrespondeAPrograma: () => true,
    verificarEnlace: async () => ({ ok: true, formato: 'pdf' }),
    _limpiarCacheBrochures: () => {},
  },
});

const m = await import('../src/crm/correoInformacion');
const { htmlCorreoInformacion, asuntoCorreoInformacion, diasEntre } = await import('../src/crm/correoInformacionHtml');
const { promesaDeCorreo } = await import('../src/core/promesas');
const { matchProgramaCarver } = await import('../src/core/condicionesCarver');
const { correoInformacionActivo } = await import('../src/crm/correoActivo');
const { WHATSAPP_PROFILE } = await import('../src/core/channel');
const { SYSTEM_PROMPT } = await import('../src/ai/prompt');
const auth = { domain: 'test.bitrix24.com', access_token: 'tok' } as any;

let dealSeq = 1000;
function reset() {
  dealSeq += 1;
  deal = { ID: dealSeq, CATEGORY_ID: '73', CONTACT_ID: '77', ASSIGNED_BY_ID: '685355' };
  contacto = { NAME: 'Ana María', EMAIL: [{ VALUE: 'persona@yahoo.com', VALUE_TYPE: 'WORK' }] };
  llamadas = [];
  enviado = true;
  brochure = { ok: true, programa: 'Licenciatura en Psicología', url: 'https://portal.test/brochure-psicologia.pdf', formato: 'pdf' };
}
const ents = () => ({ deal: dealSeq, contact: 77 });
const psicologia = () => matchProgramaCarver('Licenciatura en Psicología').find((p) => p.nombre === 'Licenciatura en Psicología')!;
const agregada = () => llamadas.find((l) => l.method === 'crm.activity.add')?.params.fields;

const base = () => ({
  nombre: 'Ana María',
  programa: psicologia(),
  duracion: '4 años',
  ingreso: { inicio: '2026-11-23', cierre: '2026-11-20' },
  brochureUrl: 'https://portal.test/brochure-psicologia.pdf',
  asesor: { nombre: 'Asesora de Prueba', whatsapp: '+56912345678', email: 'asesora@carver.university', formulario: 'https://carver.university/forms/x' },
  hoy: '2026-11-09',
});

test('el correo trae las cifras de la planilla, como un arancel oficial', () => {
  const h = htmlCorreoInformacion(base());
  assert.match(h, /OFICINA DE ADMISIÓN/);
  assert.match(h, /9 de noviembre de 2026/); // la fecha de la carta
  assert.match(h, /Licenciatura en Psicología/);
  assert.match(h, /Licenciatura &nbsp;·&nbsp; 4 años/);
  assert.match(h, /Ana, reciba un cordial saludo\./); // solo el primer nombre
  assert.match(h, /Arancel de lista<\/td>.*?USD 8\.000/s);
  assert.match(h, /Beca George Washington Carver Grant \(50 %\)<\/td>.*?&minus; USD 4\.000/s);
  assert.match(h, /<strong>Arancel con beca<\/strong>.*?<strong>USD 4\.000<\/strong>/s);
  assert.match(h, /40 cuotas, más matrícula de USD 50 \(regular USD 150\)/);
  assert.match(h, /8 pagos, sin matrícula \(total USD 3\.280\)/);
  // El contado de una licenciatura es por año, y es la opción de mayor ahorro.
  assert.match(h, /Anual al contado.*?4 pagos anuales, sin matrícula \(total USD 2\.340\).*?Opción de mayor ahorro.*?USD 585.*?por año/s);
  assert.match(h, /CIERRE DE POSTULACIÓN<\/td><td[^>]*>viernes 20 de noviembre de 2026/);
  assert.match(h, /INICIO DE CLASES<\/td><td[^>]*>lunes 23 de noviembre de 2026/);
  assert.match(h, /Quedan 11 días para completar su postulación\./);
  assert.match(h, /Licencia N\.º 12743 de la Commission for Independent Education/);
  assert.match(h, /href="https:\/\/portal\.test\/brochure-psicologia\.pdf"[^>]*>brochure del programa/);
  assert.match(h, /href="https:\/\/carver\.university\/forms\/x"[^>]*>postulación en línea<\/a> antes del viernes 20 de noviembre de 2026/);
  assert.match(h, /href="https:\/\/carver\.university\/forms\/x"[^>]*>INICIAR POSTULACIÓN/);
  assert.match(h, /escríbame por <a href="https:\/\/wa\.me\/56912345678"/);
  assert.match(h, /Atentamente,.*?Asesora de Prueba.*?WhatsApp \+56 9 1234 5678/s);
  assert.doesNotMatch(h, /[\u{10000}-\u{10FFFF}]/u); // sin emojis: Bitrix los corta
});

test('sin asesor, sin brochure ni fechas, el correo no inventa nada', () => {
  const h = htmlCorreoInformacion({ ...base(), nombre: '', ingreso: null, brochureUrl: undefined, asesor: null });
  assert.match(h, />Reciba un cordial saludo\./);
  assert.doesNotMatch(h, /CALENDARIO|INICIAR POSTULACIÓN|WhatsApp|brochure/i);
  assert.match(h, /le acompañamos en cada paso/);
  assert.match(h, /Atentamente,.*?Oficina de Admisión/s);
});

test('lo que viene de afuera se escapa', () => {
  const h = htmlCorreoInformacion({ ...base(), nombre: '<script>alert(1)</script>', asesor: { nombre: 'X"><img>', formulario: 'javascript:alert(1)' } });
  assert.doesNotMatch(h, /<script>|<img>|javascript:/);
});

test('con cupos completos avisa la reapertura y no invita a postular', () => {
  const p = { ...psicologia(), cotizable: false, motivoNoCotizable: 'cupos completos', reabre: 'marzo de 2027' };
  const h = htmlCorreoInformacion({ ...base(), programa: p });
  assert.match(h, /Cupos completos\.<\/strong> La matrícula de este programa reabre en marzo de 2027/);
  assert.doesNotMatch(h, /CALENDARIO|INICIAR POSTULACIÓN|postulación en línea/);
});

test('una maestría con contado único lo dice como un pago', () => {
  const p = matchProgramaCarver('Maestría en Psicología').find((x) => x.nombre === 'Maestría en Psicología')!;
  const h = htmlCorreoInformacion({ ...base(), programa: p, duracion: '12 meses de clases (12 módulos)' });
  assert.match(h, /Maestría &nbsp;·&nbsp; 12 meses de clases &nbsp;·/);
  assert.match(h, /Al contado.*?Pago único, sin matrícula.*?USD 900.*?pago único/s);
});

test('los días para postular y el asunto', () => {
  assert.equal(diasEntre('2026-11-09', '2026-11-20'), 11);
  assert.match(htmlCorreoInformacion({ ...base(), hoy: '2026-11-20' }), /La postulación cierra hoy\./);
  assert.doesNotMatch(htmlCorreoInformacion({ ...base(), hoy: '2026-09-01' }), /para completar su postulación/); // muy lejos: sin cuenta regresiva
  assert.equal(asuntoCorreoInformacion('Ana María', 'Licenciatura en Psicología'), 'Ana: información de la Licenciatura en Psicología | Carver University');
  assert.equal(asuntoCorreoInformacion('', 'Maestría en Psicología'), 'Información de la Maestría en Psicología | Carver University');
});

test('el próximo ingreso es el más cercano con la postulación abierta', () => {
  const cal = [
    { ciclo: 'C04', programa: 'todos', inicioClases: '2026-10-26', cierrePostulacion: '2026-10-23' },
    { ciclo: 'C05', programa: 'todos', inicioClases: '2026-11-23', cierrePostulacion: '2026-11-20' },
    { ciclo: 'C06', programa: 'todos', inicioClases: '2027-01-11', cierrePostulacion: '2027-01-08' },
    { ciclo: 'X1', programa: 'Maestría en Ingeniería', inicioClases: '2026-11-16', cierrePostulacion: '2026-11-13' },
  ];
  assert.deepEqual(m.proximoIngreso(cal, 'Licenciatura en Psicología', '2026-11-07'), { inicio: '2026-11-23', cierre: '2026-11-20' });
  assert.deepEqual(m.proximoIngreso(cal, 'Maestría en Ingeniería', '2026-11-07'), { inicio: '2026-11-16', cierre: '2026-11-13' });
  assert.deepEqual(m.proximoIngreso(cal, 'Licenciatura en Psicología', '2026-11-21'), { inicio: '2027-01-11', cierre: '2027-01-08' });
  assert.equal(m.proximoIngreso(cal, 'Licenciatura en Psicología', '2027-02-01'), null);
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

test('envía: un correo de la negociación, desde el buzón de admisión', async () => {
  reset();
  const r: any = await m.enviarInformacionPorCorreo('Licenciatura en Psicología', ents(), auth);
  assert.equal(r.ok, true);
  assert.equal(r.enviadoA, 'persona@yahoo.com');
  assert.equal(r.conBrochure, true);
  const f = agregada();
  assert.equal(f.OWNER_TYPE_ID, 2);
  assert.equal(f.OWNER_ID, dealSeq);
  assert.equal(f.TYPE_ID, 4);
  assert.equal(f.DIRECTION, 2);
  assert.equal(f.DESCRIPTION_TYPE, 3);
  assert.equal(f.RESPONSIBLE_ID, 685355);
  assert.deepEqual(f.SETTINGS, { MESSAGE_FROM: 'Carver University <admissioncarver@carver.university>' });
  assert.deepEqual(f.COMMUNICATIONS, [{ VALUE: 'persona@yahoo.com', ENTITY_ID: 77, ENTITY_TYPE_ID: 3, TYPE: 'EMAIL' }]);
  assert.equal(f.SUBJECT, 'Ana: información de la Licenciatura en Psicología | Carver University');
  assert.match(f.DESCRIPTION, /40 cuotas/);
  assert.match(f.DESCRIPTION, /brochure-psicologia\.pdf/);
  assert.equal(f.FILES, undefined); // el brochure va como enlace, no como adjunto
  assert.equal(await m.correoEnviadoHace(dealSeq, 60), true);
});

test('si Bitrix no confirma el envío, no se da por enviado', async () => {
  reset();
  enviado = false;
  const r: any = await m.enviarInformacionPorCorreo('Licenciatura en Psicología', ents(), auth);
  assert.deepEqual([r.ok, r.motivo], [false, 'fallo_envio']);
  assert.equal(m.requiereAviso(r.motivo), true);
  assert.equal(await m.correoEnviadoHace(dealSeq, 60), false);
});

test('no lo manda dos veces, salvo que diga que no le llegó', async () => {
  reset();
  await m.enviarInformacionPorCorreo('Licenciatura en Psicología', ents(), auth);
  llamadas = [];
  const r2: any = await m.enviarInformacionPorCorreo('Licenciatura en Psicología', ents(), auth, { ultimoMensajeCliente: 'Gracias' });
  assert.equal(r2.yaEnviado, true);
  assert.equal(agregada(), undefined);
  const r3: any = await m.enviarInformacionPorCorreo('Licenciatura en Psicología', ents(), auth, { ultimoMensajeCliente: 'No me llegó nada' });
  assert.equal(r3.ok, true);
  assert.equal(r3.yaEnviado, undefined);
  assert.ok(agregada());
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

test('sin brochure verificado sale igual, sin el botón', async () => {
  reset();
  brochure = { ok: false, motivo: 'timeout' };
  const r: any = await m.enviarInformacionPorCorreo('Licenciatura en Psicología', ents(), auth);
  assert.equal(r.ok, true);
  assert.equal(r.conBrochure, false);
  assert.doesNotMatch(agregada().DESCRIPTION, /brochure/i);
});

test('al modelo le llega el correo enmascarado, nunca la dirección completa', async () => {
  reset();
  const r: any = await m.enviarInformacionPorCorreo('Licenciatura en Psicología', ents(), auth);
  const paraModelo = JSON.stringify(m.resultadoParaElModelo(r));
  assert.doesNotMatch(paraModelo, /persona@/);
  assert.match(paraModelo, /p\*\*\*@yahoo\.com/);
  assert.match(paraModelo, /termina en @yahoo\.com/);
});

test('con dos correos va al que la persona dio; sin eso, no envía solo', async () => {
  reset();
  contacto = { NAME: 'Ana', EMAIL: [{ VALUE: 'viejo@hotmail.com' }, { VALUE: 'persona@yahoo.com' }] };
  const r: any = await m.enviarInformacionPorCorreo('Licenciatura en Psicología', ents(), auth);
  assert.deepEqual([r.ok, r.motivo], [false, 'varios_correos']);
  assert.equal(agregada(), undefined);
  assert.equal(m.requiereAviso(r.motivo), true);

  reset();
  contacto = { NAME: 'Ana', EMAIL: [{ VALUE: 'viejo@hotmail.com' }, { VALUE: 'persona@yahoo.com' }] };
  const r2: any = await m.enviarInformacionPorCorreo('Licenciatura en Psicología', ents(), auth, { emailDado: ' Persona@Yahoo.com' });
  assert.equal(r2.ok, true);
  assert.equal(agregada().COMMUNICATIONS[0].VALUE, 'persona@yahoo.com');
});

test('si el correo que acaba de dar no está en la ficha, espera a que se guarde', async () => {
  reset();
  contacto = { NAME: 'Ana', EMAIL: [{ VALUE: 'viejo@hotmail.com' }] };
  const r: any = await m.enviarInformacionPorCorreo('Licenciatura en Psicología', ents(), auth, { emailDado: 'persona@yahoo.com' });
  assert.deepEqual([r.ok, r.motivo], [false, 'correo_distinto']);
  assert.equal(agregada(), undefined);
  assert.match(String(m.resultadoParaElModelo(r).nota), /registrar_interes_crm/);
});

test('sin correo en la ficha no envía y pide registrarlo', async () => {
  reset();
  contacto = { NAME: 'Ana', EMAIL: [] };
  const r: any = await m.enviarInformacionPorCorreo('Licenciatura en Psicología', ents(), auth);
  assert.deepEqual([r.ok, r.motivo], [false, 'sin_correo']);
  assert.equal(agregada(), undefined);
  assert.match(String(m.resultadoParaElModelo(r).nota), /registrar_interes_crm/);
});

test('una negociación de otro embudo no se toca', async () => {
  reset();
  deal = { ...deal, CATEGORY_ID: '3' };
  const r: any = await m.enviarInformacionPorCorreo('Licenciatura en Psicología', ents(), auth);
  assert.deepEqual([r.ok, r.motivo], [false, 'embudo_ajeno']);
  assert.equal(agregada(), undefined);
});

test('un programa que no está en la planilla no se envía', async () => {
  reset();
  const r: any = await m.enviarInformacionPorCorreo('Doctorado en Astrofísica', ents(), auth);
  assert.deepEqual([r.ok, r.motivo], [false, 'programa_no_encontrado']);
  assert.equal(llamadas.length, 0);
});

test('con el remitente configurado, el bot tiene la herramienta y la regla en el prompt', () => {
  assert.equal(correoInformacionActivo(), true);
  assert.ok(WHATSAPP_PROFILE.toolNames.includes('enviar_informacion_por_correo'));
  assert.match(SYSTEM_PROMPT, /INFORMACIÓN POR CORREO: cuando la persona pida/);
  assert.match(SYSTEM_PROMPT, /Explica que es para enviarle la información y darle seguimiento\./);
});
