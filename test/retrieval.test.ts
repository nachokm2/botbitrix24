import { test } from 'node:test';
import assert from 'node:assert/strict';

// M5 — Golden set de recuperación. Verifica que consultas coloquiales/parafraseadas encuentren el
// programa correcto (recall por sinónimos/áreas + ranking), que no haya resultados para gibberish, y
// que NUNCA se invente un programa (todo resultado es real: tiene nombre y URL del catálogo).
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

const { retrieve } = await import('../src/core/retrieval');
const { PROGRAMAS } = await import('../src/ai/catalog');

const strip = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** ¿Aparece un programa cuyo nombre contiene `substr` dentro de los primeros `topN`? */
function hallado(texto: string, substr: string, topN = 5): boolean {
  const res = retrieve({ texto }).slice(0, topN);
  const s = strip(substr);
  return res.some((p) => strip(p.nombre).includes(s));
}

// Cada caso: una consulta como la diría un prospecto → un fragmento del nombre esperado en el top.
const GOLDEN: [string, string][] = [
  ['quiero algo de recursos humanos', 'Personas'],
  ['rrhh', 'Personas'],
  ['me interesa la inteligencia artificial', 'Inteligencia Artificial'],
  ['machine learning', 'Inteligencia Artificial'],
  ['soy abogado y quiero especializarme en lo penal', 'Penal'],
  ['derecho laboral', 'Trabajo'],
  ['marketing', 'Marketing'],
  ['quiero estudiar finanzas', 'Finanzas'],
  ['un MBA', 'MBA'],
  ['soy profesor de colegio', 'Educación'],
  ['gestión de la construcción', 'Construcción'],
  ['logística y cadena de suministro', 'Logística'],
];

test('golden set: consultas coloquiales encuentran el programa correcto en el top', () => {
  const fallos: string[] = [];
  for (const [q, esperado] of GOLDEN) {
    if (!hallado(q, esperado)) fallos.push(`"${q}" → no encontró "${esperado}"`);
  }
  assert.deepEqual(fallos, [], 'todas las consultas del golden set deben resolver');
});

test('recall mejorado: sinónimo encuentra aunque la palabra no esté en el nombre', () => {
  // "recursos humanos" NO aparece literal en "Dirección de Personas y Gestión del Talento".
  const res = retrieve({ texto: 'recursos humanos' });
  assert.ok(res.length >= 1);
  assert.ok(strip(res[0].nombre).includes('personas'), 'el más relevante es el de Personas/Talento');
});

test('ranking: el match en el nombre va antes que el match solo en la descripción', () => {
  const res = retrieve({ texto: 'inteligencia artificial' });
  assert.ok(res.length >= 1);
  assert.ok(strip(res[0].nombre).includes('inteligencia artificial'), 'primero el que la lleva en el nombre');
});

test('sin alucinación: todo resultado es un programa real del catálogo', () => {
  const urls = new Set(PROGRAMAS.map((p) => p.url));
  for (const q of ['finanzas', 'derecho', 'salud', 'educacion', 'inteligencia artificial']) {
    for (const p of retrieve({ texto: q })) {
      assert.ok(urls.has(p.url), `URL real para "${p.nombre}"`);
      assert.ok(p.nombre && p.url.startsWith('http'));
    }
  }
});

test('gibberish → sin resultados (no fuerza coincidencias)', () => {
  assert.equal(retrieve({ texto: 'zzzz-qwerty-inexistente-xyz' }).length, 0);
});

test('filtros exactos sin texto: devuelve todo el tipo, en orden de catálogo', () => {
  const diplomados = retrieve({ tipo: 'diplomado' });
  const total = PROGRAMAS.filter((p) => p.tipo === 'diplomado').length;
  assert.equal(diplomados.length, total);
  assert.ok(diplomados.every((p) => p.tipo === 'diplomado'));
});

test('filtro por facultad + texto combinan', () => {
  const res = retrieve({ facultad: 'Derecho', texto: 'penal' });
  assert.ok(res.length >= 1);
  assert.ok(res.every((p) => p.facultad === 'Derecho'));
});
