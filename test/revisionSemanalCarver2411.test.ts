import { test } from 'node:test';
import assert from 'node:assert/strict';

// Revisión semanal de Carver del 17 al 24-11-2026 (502 chats). Todos los textos son mensajes reales de
// ese período, sin datos personales; el id del chat va al lado.
process.env.MARCA = 'carver';
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.HORARIO_ASESORES_ACTIVO = 'false';

const { esRechazo, motivoPorLoConversado, problemasDelRecordatorio, recordatorioSeguro } = await import('../src/ai/seguimiento');
const { pideNoMolestar } = await import('../src/crm/exclusion');
const { detectarVoseo } = await import('../src/core/guardRespuesta');
const { respuestaAPlantilla } = await import('../src/core/ecos');
const { intencionDePago } = await import('../src/core/promesas');

// ---------------------------------------------------------------------------------------------
// Bajas escritas que se ignoraban: recibían de 2 a 10 recordatorios más.
// ---------------------------------------------------------------------------------------------
test('esRechazo reconoce las bajas escritas que se escapaban', () => {
  const bajas: Array<[string, string]> = [
    ['1621633', 'Ya no gracias'],
    ['1621633', 'Pero no gracias'],
    ['1594809', 'Si gracias pero ya no ya gracias'],
    ['1613315', 'No gracia Ya dije q no'],
    ['1621871', 'No me entresa gracias'],
    ['1621493', 'No Garcías Buenos días'],
    ['1625657', 'ninguna me ineresa gracias'],
    ['1542531', 'No me mande más mensaje'],
    ['1622403', 'Oiga, no entiendo nada, lo que me está mandando es mejor que no me manden nada, de verdad'],
    ['1603735', 'Pueden dejar de mandar tantos mensajes'],
    ['1603735', 'No No escribir mas por favor'],
    ['1612515', 'No quiero estudiar por ahora para que nome manden maa mensaje por favor ni por correo'],
    ['1612719', 'Buenos días la verdad nunca me interese por un curso y no quisiera ser grosero pero no me siga insistiendo'],
    ['1612719', 'Buenos días eso mismo dijo antes y aún así me sigue enviando información'],
    ['1612515', 'Le dije en la mañana que no quería nada para que no me esté mandando un mensaje'],
    ['1622425', 'X ahora no amiga muchas gracias'],
    ['1621051', 'No nada hasta aquí quedamos'],
    ['1623211', 'Esta equivocada'],
    ['1616145', 'Disculpa me equivoque en enviar mis datos'],
  ];
  for (const [chat, texto] of bajas) assert.equal(esRechazo(texto), true, `chat ${chat}: «${texto}»`);
});

test('esRechazo no corta a quien sigue interesado o dice otra cosa', () => {
  const siguen = [
    'No quiero el otro que mencionas', // 1612127: elige entre dos opciones
    'No gracias, prefiero la licenciatura',
    'No gracias, ¿y la beca cuánto es?',
    'Eso quiero, pero no quiero estudiar mucho tiempo, ya tengo 55 años,', // 1626191: una condición
    'No me llegó ningún link', // 1613101: es un reclamo, no una baja
    'No me sirve ese horario',
    'Gracias, me lo pienso',
    'Si gracias',
    'Ok',
    'Cuánto cuesta la maestría',
    'no sé todavía',
  ];
  for (const texto of siguen) assert.equal(esRechazo(texto), false, `«${texto}»`);
});

test('una despedida corta no borra el no que la precede', () => {
  // Chat 1621221: «No Gracias Además no soy profesional de salud» y luego «Thanks You for information…»:
  // recibió cinco recordatorios.
  const conversacion = [
    'Bot: ¿Te cuento los requisitos?',
    'Cliente: No Gracias Además no soy profesional de salud',
    'Bot: Entiendo.',
    'Cliente: Thanks You for information You have great day Bye',
  ].join('\n');
  assert.equal(motivoPorLoConversado(conversacion, true), 'rechazo');
  // Con «gracias» en el medio también: sigue siendo cortesía.
  assert.equal(motivoPorLoConversado('Bot: ¿Algo más?\nCliente: ya no gracias\nCliente: ok\nCliente: gracias', true), 'rechazo');
});

test('si después del no vuelve a hablar del programa, la secuencia sigue', () => {
  const pregunta = ['Bot: ¿Te cuento?', 'Cliente: no gracias', 'Bot: Claro.', 'Cliente: ¿y cuánto cuesta la maestría?'].join('\n');
  assert.equal(motivoPorLoConversado(pregunta, true), null);
  const interes = ['Bot: ¿Te cuento?', 'Cliente: no gracias', 'Bot: Claro.', 'Cliente: bueno, envíame el brochure'].join('\n');
  assert.equal(motivoPorLoConversado(interes, true), null);
  // Un mensaje largo y sin rechazo también reabre la conversación.
  const largo = ['Bot: ¿Te cuento?', 'Cliente: no gracias', 'Bot: Claro.', 'Cliente: la verdad es que lo estuve pensando bastante y creo que tengo que hablar primero con mi familia'].join('\n');
  assert.equal(motivoPorLoConversado(largo, true), null);
});

test('pideNoMolestar: «mandar» y «dejar de» también son bajas, y «no me mandaron» no', () => {
  for (const t of ['No me mande más mensaje', 'mejor que no me manden nada', 'para que nome manden maa mensaje por favor', 'Pueden dejar de mandar tantos mensajes', 'no me envíen más correos']) {
    assert.equal(pideNoMolestar(t), true, t);
  }
  for (const t of ['No me mandaron el brochure', 'no me envió la ficha', 'me puede mandar el brochure', 'no me mande el brochure por correo']) {
    assert.equal(pideNoMolestar(t), false, t);
  }
});

// ---------------------------------------------------------------------------------------------
// Aviso «un cliente quiere pagar» al tocar «Ya no estoy interesado».
// ---------------------------------------------------------------------------------------------
test('el aviso de pago mira lo que escribió la persona, no la plantilla que citó', () => {
  const SEP = '------------------------------------------------------';
  const plantilla =
    `${SEP}\n"Hola 👋 Estamos cerrando el proceso de admisión y queremos saber cómo deseas continuar. ` +
    `Si quieres pagar ahora, puedes proceder con el pago o pedir ayuda."  | [Ya no estoy interesado]\n${SEP}\nYa no estoy interesado`;
  assert.equal(intencionDePago(plantilla), true, 'con la plantilla entera, el aviso salía');
  assert.equal(respuestaAPlantilla(plantilla), 'Ya no estoy interesado');
  assert.equal(intencionDePago(respuestaAPlantilla(plantilla) ?? plantilla), false);
  assert.equal(intencionDePago('quiero pagar de contado'), true);
});

// ---------------------------------------------------------------------------------------------
// Voseo.
// ---------------------------------------------------------------------------------------------
test('detectarVoseo marca el voseo y deja pasar el tuteo, los nombres y las palabras que terminan igual', () => {
  const voseo = [
    'Escribime cuando quieras',
    '¿Querés que te cuente el valor?',
    'Si podés, me avisás',
    '¿Seguís interesado en la maestría?',
    'Contame qué necesitás',
    '¿Tenés dudas?',
    'Decime si preferís la licenciatura',
    '¿Me decís qué necesitabas hacer?',
    'vos elegís',
    'Mirá, la ficha es corta',
  ];
  for (const t of voseo) assert.ok(detectarVoseo(t).length > 0, t);
  const tuteo = [
    'Escríbeme cuando quieras',
    '¿Quieres que te cuente el valor?',
    'Si puedes, avísame',
    '¿Sigues interesado?',
    'Cuéntame qué necesitas',
    'Tomás, ¿te cuento cómo funciona?',
    'Tu interés es importante para nosotros',
    'Además, el inglés no es requisito',
    'Después te escribo con el valor',
    '¿Estás en Chile o en otro país?',
    'Nicolás, la postulación cierra el 8 de enero',
    'Sabrás más cuando completes la ficha',
  ];
  for (const t of tuteo) assert.deepEqual(detectarVoseo(t), [], t);
});

// ---------------------------------------------------------------------------------------------
// Controles del texto de los recordatorios.
// ---------------------------------------------------------------------------------------------
test('problemasDelRecordatorio rechaza los recordatorios que se vieron en producción', () => {
  const malos: Array<[string, string, RegExp]> = [
    ['voseo', '¿Seguís pensando en esperar a marzo o te gustaría conocer otras carreras?', /voseo/],
    ['voseo', 'Si querés, escribime cuando puedas y vemos qué programa te queda mejor.', /voseo/],
    ['razonamiento interno (1612515)', 'No hay mensaje que escribir. Francisca pidió no ser contactada y eso se respeta.', /razonamiento/],
    ['razonamiento interno (1319127)', 'Ahí va el mensaje: Cuando Geomara tenga un momento, me cuenta qué área de la psicología la atrae más.', /razonamiento/],
    ['disculpa a un reclamo que no existió (1620727)', 'Tienes razón, disculpa. Aquí va de nuevo: me gustaría ayudarte con los detalles de esos beneficios.', /respuesta a algo que la persona no dijo/],
    ['revisión inventada (1621105)', 'Revisé la conversación y veo que ya te envié el brochure y quedó pendiente que te cuente el valor.', /respuesta a algo que la persona no dijo/],
    ['promete contenido (1611705)', 'Te dejo la inversión acá para que la revises con calma y me dices si te quedan dudas.', /promete algo que no incluye/],
    ['promete contenido (1608239)', 'Te dejo un paso a paso de cómo enviar tu postulación, así ves que es rápido.', /promete algo que no incluye/],
    ['promete contenido (1610887)', 'Te dejo los detalles de los programas que tenemos para que veas cuál se ajusta mejor.', /promete algo que no incluye/],
    ['aquí está', 'Aquí está el desglose de las cuotas para que lo revises.', /promete algo que no incluye/],
    ['termina en dos puntos', 'Mira lo que te preparé:', /dos puntos/],
    ['gestión inventada (1621051)', 'Mauricio, solo para confirmar: ya procesé tu solicitud de eliminación el lunes pasado.', /gestión|llamada|confirmación/],
    ['matrícula confirmada (1611639)', 'Ya confirmamos tu matrícula, así que mañana te paso el siguiente paso.', /gestión|llamada|confirmación/],
    ['envío inventado (574127)', 'Ya debería estar en tu bandeja el enlace de la ficha, ¿te llegó?', /gestión|llamada|confirmación/],
    ['descarga inventada (1615255)', 'Vi que descargaste el brochure, ¿te quedó clara la estructura del programa?', /gestión|llamada|confirmación/],
    ['perfil revisado (1621759)', 'Revisé tu perfil y la maestría encaja con tu trabajo, ¿te cuento cómo son las clases?', /gestión|llamada|confirmación/],
    ['llamada que no puede hacer (1622425)', '¿Te llamo el lunes para coordinar los detalles?', /gestión|llamada|confirmación/],
    ['contactar al equipo (1602281)', 'El acceso sigue sin funcionar; voy a contactar a Daniela ahora mismo para que lo resuelva.', /gestión|llamada|confirmación/],
    ['dice tener la ficha y no la envía (1112243)', 'Ya tengo el enlace de tu ficha para que puedas completarla cuando puedas. ¿La iniciaste ya?', /tener algo a mano/],
    ['promete hacerlo ahora (1561653)', 'Te preparo el enlace de pago ahora mismo si lo necesitas.', /tener algo a mano/],
    ['promete confirmar en un momento (1611639)', 'Te confirmo en un momento si el correo llegó a tu bandeja de entrada.', /tener algo a mano/],
  ];
  for (const [que, texto, esperado] of malos) {
    const p = problemasDelRecordatorio(texto);
    assert.ok(p.some((x) => esperado.test(x)), `${que}: «${texto}» → ${JSON.stringify(p)}`);
  }
});

test('problemasDelRecordatorio deja pasar los recordatorios normales y los textos seguros', () => {
  const buenos = [
    '¿Pudiste revisar el brochure que te envié? Si te quedó alguna duda, te la resuelvo por aquí.',
    'Si quieres, te paso el valor con la beca y vemos cuál forma de pago te acomoda.',
    '¿Te paso el detalle de la inversión para que lo revises con calma?',
    'Cuando tengas un momento, me cuentas qué te falta para decidir y lo vemos.',
    'Quizá no es el momento, y está bien; me puedes escribir cuando te acomode.',
    '¿Sigues con interés en la maestría? Con un sí o un no me basta para saber cómo ayudarte.',
    'El próximo ciclo cierra postulación el 8 de enero; ¿te cuento cómo es el proceso?',
    '¿Quieres que te confirme en un momento cuándo cierra la postulación?',
    'Si quieres, te paso el valor cuando tengas un momento.',
    '¿Tienes el diploma de enseñanza media a mano?',
  ];
  for (const texto of buenos) assert.deepEqual(problemasDelRecordatorio(texto), [], texto);
  // El texto seguro que sale cuando el modelo no logra uno aceptable no puede fallar sus propios controles.
  for (const tipo of ['primero', 'intermedio', 'cierre'] as const) {
    for (let etapa = 1; etapa <= 5; etapa++) {
      const t = recordatorioSeguro(tipo, etapa, []);
      assert.deepEqual(problemasDelRecordatorio(t), [], `${tipo} ${etapa}: ${t}`);
    }
  }
});
