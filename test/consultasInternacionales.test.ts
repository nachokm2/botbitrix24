import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Modo internacional, 17-11-2026: nadie del equipo habla inglés ni hindi, así que el bot atiende solo y
// nunca traspasa. Lo que no sabe se lo consulta a una persona por el chat privado del bot en Bitrix, y la
// respuesta (en español) vuelve a la persona en su idioma. Ver core/consultasInternacionales.ts.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.MARCA = 'carver';
process.env.INTERNACIONAL_PREFIJOS = '+91';
process.env.INTERNACIONAL_AVISAR_A = '4173';

type Llamada = { method: string; params: any };
const llamadas: Llamada[] = [];
let siguienteId = 9000;
let fallarPrivado = false;
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: async (method: string, params: any) => {
      llamadas.push({ method, params });
      if (method === 'imbot.message.add' && fallarPrivado && /^\d+$/.test(String(params.DIALOG_ID))) throw new Error('ACCESS_DENIED');
      return method === 'imbot.message.add' ? ++siguienteId : true;
    },
    callCrm: async () => ({}),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: [], total: 0, next: null }),
    callWebhook: async () => ({}),
  },
});

let respuestaModelo = '';
let pedidosAlModelo: any[] = [];
mock.module('../src/ai/client.ts', {
  namedExports: {
    anthropic: {
      messages: {
        create: async (req: any) => {
          pedidosAlModelo.push(req);
          return { content: [{ type: 'text', text: respuestaModelo }], usage: {} };
        },
      },
    },
    REASONER: 'modelo-de-prueba',
    CLASSIFIER: 'clasificador-de-prueba',
  },
});

const C = await import('../src/core/consultasInternacionales');
const R = await import('../src/core/ruidoInternacional');
const { setHistory, getHistory } = await import('../src/ai/memory');

const auth = { domain: 'test.bitrix24.com', access_token: 'x' } as any;
const BOT = 800185;

const privadosA = (userId: string) => llamadas.filter((l) => l.method === 'imbot.message.add' && String(l.params.DIALOG_ID) === userId);
const alChat = (dialogId: string) => llamadas.filter((l) => l.method === 'imbot.message.add' && l.params.DIALOG_ID === dialogId);

test('la cita de Bitrix se separa de lo que escribió la persona', () => {
  const r = C.separarCita(
    '------------------------------------------------------\nAgente Carver [17.11.2026 10:00]\n❓ Consulta #K7Q2 · programa internacional\n------------------------------------------------------\nSí, el certificado es digital.',
  );
  assert.match(r.citado, /#K7Q2/);
  assert.equal(r.propio, 'Sí, el certificado es digital.');
  assert.deepEqual(C.separarCita('Sin cita'), { citado: '', propio: 'Sin cita' });
});

test('a qué consulta responde: la citada, la del código escrito, o la única abierta', () => {
  assert.deepEqual(C.elegirConsulta({ citado: '❓ Consulta #K7Q2', propio: 'Sí' }, ['AAAA', 'K7Q2']), { codigo: 'K7Q2', respuesta: 'Sí' });
  assert.deepEqual(C.elegirConsulta({ citado: '', propio: '#k7q2 Sí, es digital' }, ['AAAA', 'K7Q2']), { codigo: 'K7Q2', respuesta: 'Sí, es digital' });
  assert.deepEqual(C.elegirConsulta({ citado: '', propio: 'Sí', replyCodigo: 'AAAA' }, ['AAAA', 'K7Q2']), { codigo: 'AAAA', respuesta: 'Sí' });
  assert.deepEqual(C.elegirConsulta({ citado: '', propio: 'Sí' }, ['K7Q2']), { codigo: 'K7Q2', respuesta: 'Sí' });
  assert.equal(C.elegirConsulta({ citado: '', propio: 'Sí' }, ['AAAA', 'K7Q2']).motivo, 'varias');
  // Una palabra de cuatro letras al inicio no es un código si no hay una consulta con ese código.
  assert.deepEqual(C.elegirConsulta({ citado: '', propio: 'Hola, sí' }, ['K7Q2']), { codigo: 'K7Q2', respuesta: 'Hola, sí' });
});

test('solo el equipo configurado, por privado, cuenta como respuesta', () => {
  assert.equal(C.esMensajeDelEquipo('4173', '4173'), true);
  assert.equal(C.esMensajeDelEquipo('4173', 4173), true);
  assert.equal(C.esMensajeDelEquipo('chat1603954', '4173'), false, 'en el chat de la persona es un operador');
  assert.equal(C.esMensajeDelEquipo('555', '555'), false, 'otro usuario');
});

test('la consulta le llega por el chat privado del bot, con el código y cómo responder', async () => {
  llamadas.length = 0;
  const { codigo, avisados } = await C.crearConsulta(
    { dialogId: 'chat1', motivo: '¿El certificado es físico o digital?', mensajeCliente: 'Is the certificate physical?', nombre: 'Sumantra', dealId: 7, botId: BOT },
    auth,
  );
  assert.equal(avisados, 1);
  const [aviso] = privadosA('4173');
  assert.equal(aviso.params.BOT_ID, BOT);
  assert.match(aviso.params.MESSAGE, new RegExp(`Consulta #${codigo}`));
  assert.match(aviso.params.MESSAGE, /¿El certificado es físico o digital\?/);
  assert.match(aviso.params.MESSAGE, /Escribió: «Is the certificate physical\?»/);
  assert.match(aviso.params.MESSAGE, /responda este mensaje/);
  assert.match(aviso.params.MESSAGE, /IM_DIALOG=chat1/);
  assert.equal(llamadas.filter((l) => l.method === 'im.notify.personal.add').length, 0);
});

test('si Bitrix no deja escribir por privado, va como notificación con el código', async () => {
  llamadas.length = 0;
  fallarPrivado = true;
  try {
    const { codigo, avisados } = await C.crearConsulta({ dialogId: 'chat2', motivo: 'Pregunta X', botId: BOT }, auth);
    assert.equal(avisados, 1);
    const n = llamadas.find((l) => l.method === 'im.notify.personal.add');
    assert.ok(n);
    assert.match(n!.params.MESSAGE, new RegExp(`escríbale al bot «#${codigo}»`));
  } finally {
    fallarPrivado = false;
  }
});

test('la respuesta en español sale a la persona en su idioma, queda en el historial y se confirma', async () => {
  llamadas.length = 0;
  pedidosAlModelo = [];
  await setHistory('chat10', [
    { role: 'user', content: 'Is the certificate physical or digital?' },
    { role: 'assistant', content: "Good question. I'm checking that detail and will write back here." },
  ]);
  await C.marcarMensajeDelCliente('chat10', Date.now() - 2 * 3600_000);
  const { codigo } = await C.crearConsulta({ dialogId: 'chat10', motivo: '¿Certificado físico o digital?', nombre: 'Ana', botId: BOT }, auth);
  const aviso = privadosA('4173').at(-1)!;
  respuestaModelo = 'About your question on the certificate: it is digital and is sent by email at the end of the course.';
  const r = await C.procesarMensajeDelEquipo({
    fromUserId: '4173',
    mensaje: `------------------------------------------------------\n${aviso.params.MESSAGE}\n------------------------------------------------------\nEs digital y se envía por correo al terminar el curso.`,
    botId: BOT,
    auth,
  });
  assert.equal(r, 'enviada');
  assert.equal(alChat('chat10').at(-1)!.params.MESSAGE, respuestaModelo);
  assert.match(pedidosAlModelo.at(-1).messages[0].content, /Es digital y se envía por correo/);
  assert.match(pedidosAlModelo.at(-1).messages[0].content, /Person: Is the certificate physical or digital\?/);
  assert.equal((await getHistory('chat10')).at(-1).content, respuestaModelo);
  const confirmacion = privadosA('4173').at(-1)!;
  assert.match(confirmacion.params.MESSAGE, new RegExp(`✅ Le envié a Ana \\(consulta #${codigo}\\)`));
  // Ya no está abierta.
  llamadas.length = 0;
  assert.equal(await C.procesarMensajeDelEquipo({ fromUserId: '4173', mensaje: 'pendientes', botId: BOT, auth }), 'lista');
  assert.doesNotMatch(privadosA('4173')[0].params.MESSAGE, new RegExp(`#${codigo}`));
});

test('si la traducción pierde un monto o un enlace, no se envía y se avisa', async () => {
  llamadas.length = 0;
  await C.marcarMensajeDelCliente('chat11');
  const { codigo } = await C.crearConsulta({ dialogId: 'chat11', motivo: '¿Cuánto cuesta la cuota?', botId: BOT }, auth);
  respuestaModelo = 'Each instalment costs USD 20.';
  const r = await C.procesarMensajeDelEquipo({ fromUserId: '4173', mensaje: `#${codigo} Cada cuota cuesta USD 200`, botId: BOT, auth });
  assert.equal(r, 'error');
  assert.equal(alChat('chat11').length, 0);
  assert.match(privadosA('4173').at(-1)!.params.MESSAGE, /no envié nada/);
});

test('fuera de las 24 h la respuesta se guarda y se da cuando la persona vuelve a escribir', async () => {
  llamadas.length = 0;
  await C.marcarMensajeDelCliente('chat12', Date.now() - 30 * 3600_000);
  const { codigo } = await C.crearConsulta({ dialogId: 'chat12', motivo: '¿Hay clases grabadas?', botId: BOT }, auth);
  const r = await C.procesarMensajeDelEquipo({ fromUserId: '4173', mensaje: `#${codigo} Sí, todas quedan grabadas`, botId: BOT, auth });
  assert.equal(r, 'guardada');
  assert.equal(alChat('chat12').length, 0, 'WhatsApp no lo entregaría');
  assert.match(privadosA('4173').at(-1)!.params.MESSAGE, /hace 30 h/);
  const bloque = await C.bloqueRespuestaPendiente('chat12');
  assert.match(bloque, /Sí, todas quedan grabadas/);
  assert.equal(await C.bloqueRespuestaPendiente('chat12'), '', 'se usa una sola vez');
});

test('sin cita ni código y con varias abiertas, pide indicar cuál', async () => {
  llamadas.length = 0;
  await C.crearConsulta({ dialogId: 'chat20', motivo: 'Uno', botId: BOT }, auth);
  await C.crearConsulta({ dialogId: 'chat21', motivo: 'Dos', botId: BOT }, auth);
  const r = await C.procesarMensajeDelEquipo({ fromUserId: '4173', mensaje: 'Sí', botId: BOT, auth });
  assert.equal(r, 'sin_consulta');
  assert.match(privadosA('4173').at(-1)!.params.MESSAGE, /no sé a cuál corresponde/);
});

test('el pedido al modelo no menciona al equipo ni a una persona', () => {
  assert.match(C.REDACTOR_RESPUESTA_EQUIPO, /Do not mention the admissions office, the team, a person/);
  assert.match(C.REDACTOR_RESPUESTA_EQUIPO, /EXACTLY as written/);
});

test('solo enlaces o emojis: el primero se responde, los siguientes no', async () => {
  assert.equal(R.esSinContenido('https://www.instagram.com/reel/Df1SZfEz5mN/?mdxt=NjN4ZjlkbWg3aGpx'), true);
  assert.equal(R.esSinContenido('[URL=https://www.instagram.com/reel/x]https://www.instagram.com/reel/x[/URL]'), true);
  assert.equal(R.esSinContenido('🌹'), true);
  assert.equal(R.esSinContenido('👍🏽 !!'), true);
  assert.equal(R.esSinContenido('400'), false, 'un número dice algo');
  assert.equal(R.esSinContenido('Hello! Can I get more info on this? https://fb.me/7u5zqJCwB Put AI to Work'), false);
  assert.equal(R.esSinContenido('आप'), false);
  assert.equal(await R.repiteSinContenido('chat30'), false);
  assert.equal(await R.repiteSinContenido('chat30'), true);
  assert.equal(await R.repiteSinContenido('chat30'), true);
  await R.olvidarSinContenido('chat30');
  assert.equal(await R.repiteSinContenido('chat30'), false);
});

test('un botón de una plantilla en español se describe en inglés; lo demás queda igual', () => {
  const PLANTILLA =
    '------------------------------------------------------\n"Hola, Ashraf 👋 Estamos cerrando el proceso de admisión de Carver University y queremos saber cómo deseas continuar con tu postulación.\n| [Quiero matricularme ahora] | [Quiero estudiar más adelante] | [Ya no estoy interesado/a]\n------------------------------------------------------\n';
  assert.equal(
    R.botonDePlantillaEnEspanol(`${PLANTILLA}Ya no estoy interesado/a`),
    '[The person tapped the button "Ya no estoy interesado/a" (it means "I\'m no longer interested") on an automated message in Spanish that they may not have understood.]',
  );
  assert.match(R.botonDePlantillaEnEspanol(`${PLANTILLA}Quiero matricularme ahora`)!, /I want to enrol now/);
  assert.equal(R.botonDePlantillaEnEspanol(`${PLANTILLA}What is this? I don't understand Spanish, please send everything in English`), null);
  assert.equal(R.botonDePlantillaEnEspanol('Ya no estoy interesado/a'), null, 'sin cita no es un botón');
  const EN_INGLES = '------------------------------------------------------\n"Hi Dr Bharathi, do you still have a question about the programme?"\n------------------------------------------------------\nYes, I have a question';
  assert.equal(R.botonDePlantillaEnEspanol(EN_INGLES), null, 'la plantilla en inglés se responde como siempre');
});

test('17-11: aviso de interesado por el chat privado, una vez por motivo', async () => {
  llamadas.length = 0;
  const a = { dialogId: 'chat40', motivo: 'correo' as const, nombre: 'Ana', dealId: 9, mensajeCliente: 'my email is x', botId: BOT };
  assert.equal(await C.avisarInteresado(a, auth), true);
  const aviso = privadosA('4173').at(-1)!;
  assert.match(aviso.params.MESSAGE, /🔥 Interesado · programa internacional: dejó su correo/);
  assert.match(aviso.params.MESSAGE, /Persona: Ana/);
  assert.match(aviso.params.MESSAGE, /No escriba en el chat de la persona/);
  assert.match(aviso.params.MESSAGE, /crm\/deal\/details\/9\//);
  assert.equal(await C.avisarInteresado(a, auth), false, 'el mismo motivo no se repite');
  assert.equal(await C.avisarInteresado({ ...a, motivo: 'enlace_pago' }, auth), true, 'otro motivo sí');
  assert.match(privadosA('4173').at(-1)!.params.MESSAGE, /el bot le mandó el enlace de pago/);
});

test('reconoce cuándo la respuesta trae un enlace de pago de la ficha', () => {
  const urls = ['https://payment.flywire.com/pay/payment?recipient=nzc', 'https://example.com/brochure.pdf'];
  assert.equal(C.traeEnlaceDePago('You can pay here:\nhttps://payment.flywire.com/pay/payment?recipient=nzc', urls), true);
  assert.equal(C.traeEnlaceDePago('Here is the brochure: https://example.com/brochure.pdf', urls), false);
  assert.equal(C.traeEnlaceDePago('Would you like to know how to enrol?', urls), false);
});

test('las respuestas del equipo quedan para proponerlas en la ficha (no las de pagos)', async () => {
  await C.respuestasParaLaFicha(true);
  llamadas.length = 0;
  await C.marcarMensajeDelCliente('chat41');
  const { codigo } = await C.crearConsulta({ dialogId: 'chat41', motivo: '¿Hay factura GST?', botId: BOT }, auth);
  respuestaModelo = 'About the GST invoice: yes, an invoice can be issued in the company name.';
  await C.procesarMensajeDelEquipo({ fromUserId: '4173', mensaje: `#${codigo} Sí, se puede emitir a nombre de la empresa`, botId: BOT, auth });
  const pago = await C.crearConsulta({ dialogId: 'chat41', motivo: 'Pago informado: USD 400', pago: true, botId: BOT }, auth);
  await C.procesarMensajeDelEquipo({ fromUserId: '4173', mensaje: `#${pago.codigo} Recibido, gracias`, botId: BOT, auth });
  const lista = await C.respuestasParaLaFicha();
  assert.equal(lista.length, 1);
  assert.equal(lista[0].pregunta, '¿Hay factura GST?');
  assert.equal(lista[0].respuesta, 'Sí, se puede emitir a nombre de la empresa');
  await C.respuestasParaLaFicha(true);
  assert.equal((await C.respuestasParaLaFicha()).length, 0);
});

test('nombres de usuario y mensajes que son solo el anuncio', () => {
  assert.equal(R.pareceNombreDeUsuario('machineali807'), true);
  assert.equal(R.pareceNombreDeUsuario('kumar.muruga'), true);
  assert.equal(R.pareceNombreDeUsuario('Sumantra'), false);
  assert.equal(R.pareceNombreDeUsuario('Dr Bharathi'), false);
  const ANUNCIO = 'Hello! Can I get more info on this?\n\nhttps://fb.me/7u5zqJCwB\n\nPut AI to Work';
  assert.equal(R.soloMensajeDelAnuncio([ANUNCIO]), true);
  assert.equal(R.soloMensajeDelAnuncio(['नमस्ते! क्या मुझे इस बारे में और पता चल सकता है? https://fb.me/x Put AI to Work']), true, 'el anuncio traducido');
  assert.equal(R.soloMensajeDelAnuncio([ANUNCIO, 'https://www.instagram.com/reel/abc', '[imagen]', R.IMAGEN_SIN_TEXTO_INTERNACIONAL]), true);
  assert.equal(R.soloMensajeDelAnuncio([ANUNCIO, 'No code']), false);
  assert.equal(R.soloMensajeDelAnuncio(['Hello! Can I get more info on this? https://fb.me/x Put AI to Work Hiiiiiok']), false, 'escribió algo después');
  assert.equal(R.soloMensajeDelAnuncio(['[URL=https://x]Open[/URL] [voice message] Is it online?']), false, 'un audio es contenido');
});

test('17-11 tarde: más nombres de usuario, fotos seguidas y el enlace de pago ya enviado', async () => {
  assert.equal(R.pareceNombreDeUsuario('ckjharesearcher'), true, 'una palabra larga en minúsculas');
  assert.equal(R.pareceNombreDeUsuario('Shivaramakrishnan'), false, 'un nombre real con mayúscula');
  assert.equal(R.pareceNombreDeUsuario('rahul'), false, 'un nombre corto en minúsculas');
  assert.equal(R.esSinContenido(''), true, 'una foto sin texto cuenta como sin contenido');
  assert.equal(await C.yaRecibioEnlaceDePago('chat50'), false);
  await C.avisarInteresado({ dialogId: 'chat50', motivo: 'enlace_pago', botId: BOT }, auth);
  assert.equal(await C.yaRecibioEnlaceDePago('chat50'), true, 'después del enlace, una foto puede ser el comprobante');
});
