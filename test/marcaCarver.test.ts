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
const { PROGRAMAS } = await import('../src/ai/catalog');
const { getDetalle } = await import('../src/ai/detalles');
const { SYSTEM_PROMPT } = await import('../src/ai/prompt');
const { consultarProgramas } = await import('../src/core/catalogTool');
const { WHATSAPP_PROFILE } = await import('../src/core/channel');
const { tools } = await import('../src/ai/tools');
const { buscarProgramas } = await import('../src/ai/catalog');

test('marca=carver: identidad y oferta son las de Carver University, no las de Postgrados', () => {
  assert.equal(marca.key, 'carver');
  assert.match(SYSTEM_PROMPT, /asesora comercial de Carver University/);
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
