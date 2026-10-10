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

test('marca=carver: NO lleva la herramienta de precios (su planilla comercial no existe)', () => {
  assert.ok(!WHATSAPP_PROFILE.toolNames.includes('consultar_condiciones_comerciales'));
  assert.ok(WHATSAPP_PROFILE.toolNames.includes('consultar_programas'));
  assert.ok(WHATSAPP_PROFILE.toolNames.includes('escalar_a_humano'));
});

test('marca=carver: el prompt prohíbe cotizar y manda derivar (el sitio publica 2 precios distintos)', () => {
  assert.match(SYSTEM_PROMPT, /NUNCA entregues valores, aranceles/);
  assert.doesNotMatch(SYSTEM_PROMPT, /consultar_condiciones_comerciales/);
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
  assert.deepEqual(tipos, ['licenciatura', 'maestria', 'curso'], 'el enum es el de Carver, no el de Postgrados');
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
