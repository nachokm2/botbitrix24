import { test } from 'node:test';
import assert from 'node:assert/strict';

// marca.ts: el MISMO código atiende a Postgrados o a Carver según MARCA (ver src/marca.ts). Acá se
// fija el lado Carver; el default (Postgrados) se verifica en marcaPostgrados.test.ts. Van en archivos
// separados a propósito: marca.ts resuelve la marca UNA vez al importarse, así que no se puede
// cambiar dentro del mismo proceso.
process.env.MARCA = 'carver';
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

const { marca } = await import('../src/marca');
const { config } = await import('../src/config');
const { PROGRAMAS } = await import('../src/ai/catalog');
const { getDetalle } = await import('../src/ai/detalles');
const { SYSTEM_PROMPT } = await import('../src/ai/prompt');
const { consultarProgramas } = await import('../src/core/catalogTool');
const { WHATSAPP_PROFILE } = await import('../src/core/channel');
const { tools } = await import('../src/ai/tools');
const { buscarProgramas } = await import('../src/ai/catalog');

test('marca=carver: identidad y oferta son las de Carver University, no las de Postgrados', () => {
  assert.equal(marca.key, 'carver');
  // Carver se presenta con el nombre del asesor a cargo, no con el del bot (sePresentaComoAsesor),
  // así que la línea de identidad ya no dice "Eres Sofía" sino que instruye adoptar ese nombre.
  assert.match(SYSTEM_PROMPT, /asesor comercial a cargo de este caso en Carver University/);
  assert.match(SYSTEM_PROMPT, /preséntate con ESE nombre/);
  assert.doesNotMatch(SYSTEM_PROMPT, /Universidad Autónoma de Chile/);
  assert.doesNotMatch(SYSTEM_PROMPT, /magísteres|diplomados/);
});

test('marca=carver: carga el catálogo de Carver (licenciaturas, maestrías y cursos)', () => {
  const tipos = new Set(PROGRAMAS.map((p) => p.tipo));
  assert.ok(PROGRAMAS.length >= 30, `esperaba el catálogo de Carver, hay ${PROGRAMAS.length}`);
  assert.deepEqual([...tipos].sort(), ['curso', 'licenciatura', 'maestria']);
  assert.ok(!PROGRAMAS.some((p) => /Magíster/i.test(p.nombre)), 'no debe quedar ningún programa de Postgrados');
});

test('marca=carver: consultar_programas DEVUELVE resultados (no filtra por la planilla comercial de Postgrados)', () => {
  // Trampa real: esa planilla es de Postgrados; si se aplicara acá, ningún programa de Carver
  // figuraría en ella y el bot respondería "no encontré programas" a todo.
  const r: any = consultarProgramas({ texto: 'psicología' }, WHATSAPP_PROFILE.catalog.consultar);
  assert.ok(r.total > 0, 'una búsqueda real no puede volver vacía');
  assert.ok(r.programas.some((p: any) => /Psicología/i.test(p.nombre)));
});

test('marca=carver: SÍ lleva la herramienta de precios (ya tiene planilla validada por la dirección)', () => {
  assert.ok(WHATSAPP_PROFILE.toolNames.includes('consultar_condiciones_comerciales'));
  assert.ok(WHATSAPP_PROFILE.toolNames.includes('consultar_programas'));
  assert.ok(WHATSAPP_PROFILE.toolNames.includes('escalar_a_humano'));
});

// Las reglas que más fácil se rompen al cotizar Carver: contado y semestral ya vienen con el
// beneficio aplicado, así que restarles otro 50% da un precio que no existe; y son las únicas dos
// formas de pago sin matrícula.
test('marca=carver: el prompt cotiza con la planilla y protege las reglas de las formas de pago', () => {
  assert.match(SYSTEM_PROMPT, /consultar_condiciones_comerciales/);
  assert.match(SYSTEM_PROMPT, /NUNCA les restes otro 50%/);
  assert.match(SYSTEM_PROMPT, /ÚNICA forma de pago que cobra matrícula/);
  // Hallazgo 6 (auditoría oct-2026): los NOOCs dejaron de ofrecerse como "cursos gratis".
  assert.match(SYSTEM_PROMPT, /CURSOS CORTOS \(NOOCs y educación continua\): NO forman parte de la oferta/);
  assert.doesNotMatch(SYSTEM_PROMPT, /CURSOS CORTOS: son GRATIS/);
  // Hallazgo 5: los costos fuera del arancel ya no se mencionan "si preguntan por el total".
  assert.match(SYSTEM_PROMPT, /NO los menciones por iniciativa propia/);
});

// La cotización real, contra la planilla validada: los números deben calzar con los que la asesora
// le dio a una clienta en la conversación que originó esta carga.
test('marca=carver: cotiza Licenciatura en Psicología con las cifras de la planilla', async () => {
  const { buscarCondicionesCarver } = await import('../src/core/condicionesCarver');
  const r: any = buscarCondicionesCarver('Licenciatura en Psicología');

  assert.equal(r.encontrado, true);
  assert.equal(r.arancelLista, 8000);
  assert.equal(r.beca.pct, 50);
  assert.equal(r.beca.arancel, 4000);
  assert.equal(r.formasDePago.mensualidades.cuotas, 40);
  assert.equal(r.formasDePago.mensualidades.montoCuota, 100);
  assert.equal(r.formasDePago.mensualidades.matricula, 50);
  assert.equal(r.formasDePago.contado.porAnio, 585);
  assert.equal(r.formasDePago.contado.total, 2340);
  assert.equal(r.formasDePago.contado.matricula, 0, 'contado NO cobra matrícula');
  // Hallazgo 5: sin pregunta explícita, la cotización no trae los costos fuera del arancel.
  assert.equal(r.costosAdicionales, undefined, 'el fee de titulación no viaja en una cotización normal');
  const conCostos: any = buscarCondicionesCarver('Licenciatura en Psicología', { incluirCostosAdicionales: true });
  assert.equal(conCostos.costosAdicionales.titulacionUsd, 125, 'ante la pregunta explícita, la cifra es la validada');
});

test('marca=carver: un NOOC no se cotiza (ni el certificado): no forma parte de la oferta', async () => {
  // Hallazgo 6. Antes devolvía "gratis, certificado USD 20" y el bot lo ofrecía.
  const { buscarCondicionesCarver } = await import('../src/core/condicionesCarver');
  const r: any = buscarCondicionesCarver('Hacking ético');
  assert.equal(r.comercializable, false);
  assert.equal(r.gratis, undefined);
  assert.doesNotMatch(JSON.stringify(r), /certificado|arancelLista/i);
});

// Cupos completos: SÍ se cotiza, porque la persona necesita el valor para decidir si espera a marzo
// de 2027. Lo que no se hace es prometer cupo ni fecha de inicio. Esconderlos hacía perder
// interesados en los dos programas de mayor valor del catálogo (las licenciaturas de USD 8.000).
test('marca=carver: un programa con cupos completos se cotiza, avisando que la matrícula reabre', async () => {
  const { buscarCondicionesCarver } = await import('../src/core/condicionesCarver');
  const r: any = buscarCondicionesCarver('Licenciatura en Ingeniería Informática');
  assert.equal(r.arancelLista, 8000, 'debe dar el valor para que pueda decidir');
  assert.match(r.nota, /NO DISPONIBLE AHORA/);
  assert.match(r.nota, /MARZO DE 2027/);
  assert.match(r.nota, /Dilo CLARAMENTE antes del precio/, 'no debe parecer que puede inscribirse hoy');
  assert.match(r.nota, /NO prometas cupo ni fecha de inicio/);
});

// Y aparecen en el catálogo, marcados: antes se filtraban y el bot decía que no existían.
test('marca=carver: los programas con cupos completos aparecen en el catálogo, con su disponibilidad', () => {
  const r: any = consultarProgramas({ tipo: 'licenciatura' }, WHATSAPP_PROFILE.catalog.consultar);
  assert.equal(r.total, 3, 'las tres licenciaturas, no solo la que está abierta');
  const cerrada = r.programas.find((p: any) => /Ingeniería Informática/.test(p.nombre));
  assert.equal(cerrada.disponible, false);
  assert.match(cerrada.disponibilidad, /MARZO DE 2027/);
  assert.match(cerrada.disponibilidad, /No lo ofrezcas como opción actual/);
  const abierta = r.programas.find((p: any) => /Psicología/.test(p.nombre));
  assert.equal(abierta.disponibilidad, undefined, 'la que está abierta no lleva aviso');
});

test('marca=carver: el detalle de un programa trae requisitos y modalidad, pero NO precio', () => {
  const d = getDetalle({ nombre: 'Maestría en Psicología' });
  assert.ok(d, 'debe encontrar la maestría por nombre');
  assert.match(String(d!.requisitos), /título profesional|cédula/i);
  assert.match(String(d!.modalidad), /en línea/i);
  assert.equal(d!.arancel, undefined, 'el precio queda fuera hasta que Carver confirme cuál rige');
});

// El esquema de consultar_programas es lo ÚNICO que el modelo ve para elegir el tipo. Estaba cableado
// a Postgrados (enum magister/diplomado/especialidad) y Carver usa licenciatura/maestria/curso, así
// que al preguntar "¿qué maestrías tienen?" el modelo mandaba el único valor parecido que el esquema
// ofrecía —"magister"— y el catálogo devolvía CERO en silencio: el bot contestaba que no tenía
// programas disponibles. Se detectó en la primera prueba real contra el servicio de Carver.
test('marca=carver: cada tipo del esquema de consultar_programas existe de verdad en el catálogo', async () => {
  const t: any = tools.find((x: any) => x.name === 'consultar_programas');
  const tipos: string[] = t.input_schema.properties.tipo.enum;
  // Sin "curso": lo que el esquema no ofrece, el modelo no lo puede buscar ni ofrecer (hallazgo 6).
  assert.deepEqual(tipos, ['licenciatura', 'maestria'], 'el enum es el de la oferta comercial de Carver');
  for (const tipo of tipos) {
    assert.ok(buscarProgramas({ tipo }).length > 0, `el tipo "${tipo}" del esquema no devuelve ningún programa`);
  }
});

test('marca=carver: no ofrece el filtro por facultad (sus programas no tienen facultad)', async () => {
  const t: any = tools.find((x: any) => x.name === 'consultar_programas');
  assert.ok(!('facultad' in t.input_schema.properties), 'ofrecerlo haría filtrar por facultades que ningún programa tiene');
  assert.ok(/Carver University/.test(String(t.description)), 'la descripción nombra el catálogo correcto');
});

test('consultar_programas: el filtro de tipo tolera la grafía natural del modelo (tilde y mayúscula)', async () => {
  // "Maestría" es como se escribe en español; sin normalizar no coincidía con 'maestria' y daba cero.
  assert.equal(buscarProgramas({ tipo: 'Maestría' }).length, buscarProgramas({ tipo: 'maestria' }).length);
  assert.ok(buscarProgramas({ tipo: 'MAESTRIA' }).length > 0);
});

// Las dos marcas viven en el MISMO portal de Bitrix24, así que el ítem de menú del panel no puede
// llamarse igual: al instalar la segunda app quedaban dos entradas "Agente Postgrados" y no había
// forma de distinguir cuál panel abría cada una.
test('marca=carver: el panel se registra con el nombre de la marca, no con el de Postgrados', async () => {
  assert.equal(marca.etiquetaPanel, 'Carver');
  assert.ok(!/Postgrados/.test(`Agente ${marca.etiquetaPanel}`), 'el título no puede decir Postgrados');
});

// El panel es el MISMO archivo HTML para las dos marcas. Estaba cableado a Postgrados: el título
// decía "Agente de Postgrados — Panel" y el subtítulo "Universidad Autónoma de Chile", así que al
// abrirlo desde Carver se veía la institución equivocada.
test('marca=carver: el panel se sirve con el título y la organización de Carver', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const html = readFileSync(fileURLToPath(new URL('../public/dashboard/index.html', import.meta.url)), 'utf8');

  // El HTML estático no puede nombrar una institución: se inyecta al servirlo.
  assert.ok(!/Universidad Autónoma/.test(html), 'el HTML no debe traer la institución escrita');
  assert.ok(html.includes('{{PANEL_TITULO}}') && html.includes('{{PANEL_ORGANIZACION}}'));
  assert.ok(html.includes('{{TIPOS_PROGRAMA}}'), 'los tipos de programa también salen de la marca');

  // Y las secciones que no aplican a toda marca tienen que poder ocultarse.
  for (const id of ['secPiloto', 'secMarchaBlanca', 'secFacultad']) {
    assert.ok(html.includes(`id="${id}"`), `falta el ancla ${id} para poder ocultar la sección`);
  }
});

// Sin MARCHA_BLANCA_PROGRAMAS, la lista por defecto son los 2 diplomados piloto de Postgrados, con
// sus asesores y su embudo. Se aplicaba a CUALQUIER marca, así que el panel de Carver mostraba la
// proyección del correo de lanzamiento de Postgrados y una tabla con programas que Carver no dicta.
test('marca=carver: sin configuración explícita NO hereda los programas piloto de Postgrados', async () => {
  assert.equal(config.marchaBlancaProgramas.length, 0, 'una marca sin piloto propio no debe traer el de otra');
});

// El bot de Carver habla con el nombre del asesor dueño de la negociación: el cliente conversa desde
// el primer mensaje con la persona que después va a seguir su caso.
test('marca=carver: el bloque de identidad hace que el bot hable como el asesor, con sus datos', async () => {
  const { bloqueIdentidad } = await import('../src/ai/agentLoop');
  const b = bloqueIdentidad({ nombre: 'Gabriela García', email: 'gabriela@carver.university', telefono: '+56912345678' }, true);

  assert.match(b, /tu nombre es Gabriela García/);
  assert.match(b, /gabriela@carver\.university/);
  assert.match(b, /\+56912345678/);
  assert.match(b, /solo si el cliente lo pide/, 'los datos de contacto no se ofrecen por iniciativa propia');
  assert.match(b, /NUNCA digas que eres un bot/);

  // Sin correo ni teléfono, no debe inventarlos ni dejar huecos.
  const soloNombre = bloqueIdentidad({ nombre: 'Jefferson Dávila' }, true);
  assert.match(soloNombre, /tu nombre es Jefferson Dávila/);
  assert.doesNotMatch(soloNombre, /correo es|teléfono es/);
});

// El nombre se dice UNA vez, al presentarse. Si no, una reasignación a mitad de conversación hacía
// que el cliente viera a su interlocutor cambiar de nombre de un mensaje al otro, sin explicación.
test('marca=carver: el nombre solo se da al presentarse, no en los turnos siguientes', async () => {
  const { bloqueIdentidad } = await import('../src/ai/agentLoop');
  const asesor = { nombre: 'Gabriela García' };

  const primero = bloqueIdentidad(asesor, true);
  assert.match(primero, /Preséntate con él en ESTE mensaje/);
  assert.match(primero, /NO vuelvas a mencionar tu nombre/);

  const siguiente = bloqueIdentidad(asesor, false);
  assert.match(siguiente, /ya te presentaste/);
  assert.match(siguiente, /NO vuelvas a decir tu nombre/);
  assert.doesNotMatch(siguiente, /Preséntate/, 'en un turno posterior no debe volver a presentarse');
});

test('marca=postgrados NO adopta el nombre del asesor: sigue presentándose como el bot', async () => {
  assert.equal(marca.sePresentaComoAsesor, true, 'en Carver sí');
  // El lado Postgrados se verifica en marcaPostgrados.test.ts, que corre en su propio proceso.
});

// Conocimiento institucional sacado de conversaciones reales: son las preguntas que deciden la
// compra (validez del título, acreditación, devoluciones) y antes el bot derivaba todas.
test('marca=carver: el prompt trae el conocimiento institucional de las conversaciones reales', () => {
  assert.match(SYSTEM_PROMPT, /Apostilla de La Haya/);
  assert.match(SYSTEM_PROMPT, /licencia N\.º 12743/);
  assert.match(SYSTEM_PROMPT, /USD 125/, 'el costo de titulación no está en el arancel');
  assert.match(SYSTEM_PROMPT, /3 días hábiles/, 'la política de devolución debe ser textual');
});

// La clienta preguntó por ACREDITACIÓN y la asesora respondió con la LICENCIA, que es otra cosa: la
// licencia autoriza a operar, la acreditación certifica calidad académica. Si el bot repite ese
// encuadre, induce a error sobre una decisión de 4 años y varios miles de dólares.
test('marca=carver: ante una pregunta de acreditación no la confunde con la licencia y deriva', () => {
  assert.match(SYSTEM_PROMPT, /no la confundas con la licencia/i);
  assert.match(SYSTEM_PROMPT, /NUNCA afirmes que el programa está acreditado/);
  assert.match(SYSTEM_PROMPT, /la licencia autoriza a operar, la acreditación certifica la calidad académica/);
});

// La primera conversación real de Carver llegó como lead SIN negociación: el bot no tenía asesor
// que adoptar y se presentó como "el asistente virtual de Carver University", que es justo lo que
// no debe decir. La regla tiene que valer siempre, no solo cuando hay asesor.
test('marca=carver: nunca se presenta como bot ni asistente virtual, con o sin asesor', () => {
  assert.match(SYSTEM_PROMPT, /NUNCA digas que eres un bot, un asistente virtual, una IA/);
  assert.match(SYSTEM_PROMPT, /ni siquiera para aclarar un malentendido/);
});

// Pedido de Carver: cordial y formal, pero sin la rigidez de Postgrados. Y sin formato de informe:
// la primera respuesta real salió con tablas y negritas, que en WhatsApp se leen mal.
test('marca=carver: el tono es cordial y sin formato de informe', () => {
  assert.match(SYSTEM_PROMPT, /sin rigidez ni solemnidad/);
  assert.match(SYSTEM_PROMPT, /nada de negritas decorativas, tablas ni títulos/);
  assert.doesNotMatch(SYSTEM_PROMPT, /nunca tuteas ni voseas/, 'esa rigidez es de Postgrados');
});

// Carver es SOLO WhatsApp. Los endpoints de webchat, voz y redes no deben estar vivos en su
// servicio: son superficie pública sin uso y, peor, responden con la identidad de Postgrados —
// sus prompts no están parametrizados por marca y dicen "Universidad Autónoma de Chile".
test('marca=carver: no expone los canales de webchat, voz ni redes', () => {
  assert.equal(marca.otrosCanales, false);
  assert.equal(marca.tieneVoz, false);
});

// Residuos del prompt de Postgrados: mencionaban "la llamada", "el punto 5" y hasta la herramienta
// solicitar_llamada, que Carver NO lleva. Nombrar una herramienta inexistente invita a usarla.
test('marca=carver: el prompt no ofrece llamadas ni nombra solicitar_llamada', () => {
  assert.doesNotMatch(SYSTEM_PROMPT, /solicitar_llamada/, 'esa herramienta no está cargada en Carver');
  assert.doesNotMatch(SYSTEM_PROMPT, /sin ofrecer antes una llamada/);
  assert.doesNotMatch(SYSTEM_PROMPT, /ni ofrezcas la llamada/);
  assert.match(SYSTEM_PROMPT, /NO ofrezcas llamarlo tú/, 'y sí debe decir explícitamente que no llama');
});

// El esquema de la herramienta de precios estaba cableado a Postgrados: hablaba de "arancel de lista
// y bloque descuento" (la estructura de la otra marca) y ofrecía elegir sede entre Santiago y
// Temuco. Carver es 100% en línea en cinco países: el bot podía preguntarle a un cliente peruano
// por un campus chileno.
test('marca=carver: la herramienta de precios no ofrece sede ni describe la estructura de Postgrados', async () => {
  const t: any = tools.find((x: any) => x.name === 'consultar_condiciones_comerciales');
  assert.ok(!('sede' in t.input_schema.properties), 'Carver no tiene sedes: es 100% en línea');
  assert.match(t.description, /Beca George Washington Carver Grant/);
  assert.match(t.description, /TRES formas de pago/);
  assert.doesNotMatch(t.description, /bloque "descuento"/, 'esa es la estructura de Postgrados');
  assert.doesNotMatch(JSON.stringify(t), /Magíster|Temuco|Santiago/);
});

// Los 38 programas de Carver son en línea: ofrecer el filtro de modalidad invitaba al modelo a
// buscar "presencial" y recibir cero resultados. Las modalidades se derivan del catálogo real.
test('marca=carver: no ofrece filtrar por modalidad porque todo es en línea', () => {
  const t: any = tools.find((x: any) => x.name === 'consultar_programas');
  assert.ok(!('modalidad' in t.input_schema.properties), 'con una sola modalidad el filtro no discrimina nada');
  assert.equal(new Set(PROGRAMAS.map((p: any) => p.modalidad)).size, 1);
});

// "RUT" es el documento chileno y Carver atiende Chile, Perú, Ecuador, Colombia y República
// Dominicana: pedirle el RUT a un cliente peruano no se entiende.
test('marca=carver: el documento de identidad se pide como RUT/DNI, no solo RUT', () => {
  assert.equal(marca.etiquetaDocumento, 'RUT/DNI');
  const t: any = tools.find((x: any) => x.name === 'registrar_interes_crm');
  assert.match(t.input_schema.properties.rut.description, /RUT\/DNI/);
  assert.match(t.input_schema.properties.rut.description, /formato de su país/);
});

// Cuatro residuos del prompt de Postgrados que contradecían lo que Carver hace:
test('marca=carver: el prompt no contradice la identidad de asesor ni la oferta multipaís', () => {
  // 1. La lista de chilenismos no sirve para una marca que atiende cinco países.
  assert.doesNotMatch(SYSTEM_PROMPT, /cachai|bacán|cómo estai/);
  assert.match(SYSTEM_PROMPT, /jerga ni modismos propios de un solo país/);

  // 2 y 3. El bot YA es el asesor: no puede ofrecer "que un asesor lo contacte" ni anunciar que
  // "su asesor asignado" lo llamará, porque ese asesor es él mismo.
  assert.doesNotMatch(SYSTEM_PROMPT, /ofrécele que un asesor lo contacte/);
  assert.doesNotMatch(SYSTEM_PROMPT, /Su asesor asignado/);
  assert.match(SYSTEM_PROMPT, /ese asesor eres tú/);

  // 4. Carver no tiene llamadas, así que nadie puede haberlas rechazado.
  assert.doesNotMatch(SYSTEM_PROMPT, /rechazado antes una llamada/);

  // 5. La beca de Carver se ofrece de entrada, no "solo si preguntan por descuentos".
  assert.match(SYSTEM_PROMPT, /beca institucional sí puedes ofrecerla de entrada/);
});

// Ante "¿qué maestrías tienen?" el bot listaba las 13 con enlace y emoji por cada una: un muro de
// texto en WhatsApp. La nota de "afina la búsqueda" solo se disparaba pasando el límite de 20, así
// que con 13 resultados no aparecía nunca.
test('marca=carver: con muchos resultados la herramienta pide resumir por área, no enumerar', () => {
  const r: any = consultarProgramas({ tipo: 'maestria' }, WHATSAPP_PROFILE.catalog.consultar);
  assert.ok(r.total > 6, `esperaba varias maestrías, hay ${r.total}`);
  assert.match(r.nota ?? '', /NO los enumeres todos ni pegues sus enlaces/);
  assert.match(r.nota ?? '', /pregúntale cuál le interesa/);
});

test('marca=carver: con pocos resultados no pide resumir (listarlos ahí sí ayuda)', () => {
  const r: any = consultarProgramas({ tipo: 'licenciatura' }, WHATSAPP_PROFILE.catalog.consultar);
  assert.equal(r.total, 3, 'las tres licenciaturas se ofrecen; dos avisan que reabren en 2027');
  assert.equal(r.nota, undefined, 'tres opciones se enumeran sin problema');
});

test('marca=carver: el prompt prohíbe enumerar catálogos completos', () => {
  assert.match(SYSTEM_PROMPT, /NO enumeres catálogos completos/);
});

// Un cliente real reclamó: "¿por qué me pides mi nombre si lo debes tener?". Tenía razón — su ficha
// existía desde la campaña que originó la conversación, pero el bot nunca la miraba y lo pedía en
// cada mensaje. Preguntar lo que ya se sabe desgasta y resta credibilidad.
test('el bot no vuelve a pedir los datos que el CRM ya tiene', async () => {
  const { bloqueDatosConocidos } = await import('../src/ai/agentLoop');
  const b = bloqueDatosConocidos({ nombre: 'Andrea García', email: 'andrea@correo.cl', telefono: '+56 9 8765 4321' });
  assert.match(b, /nombre: Andrea García/);
  // Hallazgo 4: se confirma, no se vuelve a pedir; y va enmascarado por si el chat quedó enlazado a
  // la ficha de otra persona.
  assert.match(b, /a\*\*\*@correo\.cl/);
  assert.doesNotMatch(b, /andrea@correo\.cl/, 'el correo completo no se recita');
  assert.match(b, /terminado en 4321/);
  assert.match(b, /NO se los vuelvas a pedir/);
  assert.match(b, /CONFÍRMALO en una sola/);
  assert.match(b, /NUNCA retrasa una derivación/, 'confirmar no puede demorar a quien pidió que lo contacten (regresión R06)');
  assert.match(b, /el que da ahora es el vigente/, 'la contradicción se resuelve a favor del dato nuevo');
  assert.equal(bloqueDatosConocidos({}), '', 'sin datos conocidos no agrega nada al prompt');
});

// La frase de reserva se usaba cuando el modelo no devolvía texto. Estaba cableada a Postgrados y
// tuteaba: un cliente de Carver escribió "me interesa el MBA" y recibió "¿En qué puedo ayudarte con
// nuestros postgrados?", perdiendo el hilo.
test('marca=carver: la frase de reserva nombra a Carver y trata de usted', async () => {
  const { textOf } = await import('../src/ai/agentLoop');
  const t = (textOf as any)({ content: [] });
  assert.match(t, /Carver University/);
  assert.doesNotMatch(t, /postgrados/i);
  assert.doesNotMatch(t, /ayudarte/, 'Carver trata de usted');
});

// Conversación real: el bot cerró DIEZ mensajes seguidos pidiendo el nombre, incluso después de que
// el cliente le reclamara por qué se lo pedía. El prompt lo empujaba a eso —"completa la captura
// antes de derivar"— sin ningún tope.
test('marca=carver: el prompt pone un tope a cuántas veces pide un dato', () => {
  assert.match(SYSTEM_PROMPT, /COMO MÁXIMO dos veces/);
  assert.match(SYSTEM_PROMPT, /deja de pedirlo y sigue atendiéndolo/);
  assert.match(SYSTEM_PROMPT, /NUNCA cierres tus mensajes con la misma petición/);
  assert.match(SYSTEM_PROMPT, /si la persona te lo reprocha/);
});

// Un cliente preguntó por testimonios y por Instagram, y el bot respondió "no manejo las redes
// sociales desde acá, pero es buena idea buscarlas": le pasó la tarea justo cuando pedía pruebas
// para decidirse. Las redes salieron del sitio oficial de Carver.
test('marca=carver: conoce las redes oficiales y no inventa testimonios', () => {
  assert.match(SYSTEM_PROMPT, /instagram\.com\/carver\.university\.us/);
  assert.match(SYSTEM_PROMPT, /youtube\.com\/@CarverUniversity/);
  assert.match(SYSTEM_PROMPT, /linkedin\.com\/school\/carver-university-us/);
  assert.match(SYSTEM_PROMPT, /facebook\.com\/carver\.university\.us/);
  assert.match(SYSTEM_PROMPT, /NUNCA inventes un testimonio/);
  assert.match(SYSTEM_PROMPT, /casos VERIFICABLES de egresados/);
});

// Flywire es la plataforma de pagos de Carver — aparece además como etapa propia en sus dos embudos
// de Bitrix ("Flywire invoice"). Nombrarla da confianza: no es una transferencia suelta.
test('marca=carver: nombra Flywire pero NUNCA comparte su sitio ni un enlace de pago', () => {
  assert.match(SYSTEM_PROMPT, /FLYWIRE/);
  // El enlace de pago es PERSONAL de cada caso. Mandar la dirección general de Flywire induce a
  // pagar por fuera del link que le corresponde, y eso es un problema difícil de deshacer.
  assert.doesNotMatch(SYSTEM_PROMPT, /flywire\.com/, 'el sitio de Flywire no debe estar en el prompt');
  assert.match(SYSTEM_PROMPT, /NUNCA compartas el sitio de Flywire ni ningún enlace de pago/);
  assert.match(SYSTEM_PROMPT, /el único link válido es el que genera el asesor/);
});
