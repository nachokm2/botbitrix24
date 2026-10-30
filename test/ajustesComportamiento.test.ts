import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Sección "Comportamiento" del panel de configuración (Carver): bloques del prompt que mantiene el
// equipo. Lo más importante: sin nada publicado, el prompt queda BYTE A BYTE igual.
process.env.MARCA = 'carver';
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

const ac = await import('../src/core/ajustesComportamiento');
const { _fijarPublicadaParaPruebas, promptVigente } = await import('../src/core/ajustes');
const { SYSTEM_PROMPT } = await import('../src/ai/prompt');
const { WHATSAPP_PROFILE } = await import('../src/core/channel');
const { COSTOS_ADICIONALES_DEFECTO, INCLUYE_DEFECTO } = await import('../src/core/promptObjeciones');
const { preciosPorDefecto, validarPrecios } = await import('../src/core/ajustesProgramas');
const { buscarCondicionesCarver } = await import('../src/core/condicionesCarver');
const { panelVistaComportamiento } = await import('../src/routes/panelConfig');

beforeEach(() => {
  _fijarPublicadaParaPruebas('comportamiento', null);
  _fijarPublicadaParaPruebas('precios', null);
});

const conCambio = (cambio: Partial<Record<string, string>>) => ({ ...ac.comportamientoPorDefecto(), ...cambio });
const publicarPrecios = (costos: Record<string, number>) => {
  const v = validarPrecios({ ...preciosPorDefecto(), costosAdicionales: costos });
  assert.ok(v.ok);
  _fijarPublicadaParaPruebas('precios', v.valor);
};
const errores = (x: unknown) => {
  const v = ac.validarComportamiento(x);
  return v.ok ? [] : v.errores;
};

// ── Sin publicar, nada cambia ────────────────────────────────────────────────────────────────────
test('sin nada publicado el prompt es exactamente el de siempre', () => {
  assert.equal(promptVigente(SYSTEM_PROMPT), SYSTEM_PROMPT);
  assert.equal(promptVigente(WHATSAPP_PROFILE.systemPrompt), WHATSAPP_PROFILE.systemPrompt);
});

test('los bloques de siempre están en el prompt y pasan la validación', () => {
  const v = ac.validarComportamiento(ac.comportamientoPorDefecto());
  assert.ok(v.ok, JSON.stringify(!v.ok && v.errores));
  const r = ac.bloquesRenderizados(ac.comportamientoPorDefecto(), COSTOS_ADICIONALES_DEFECTO);
  for (const [k, texto] of Object.entries(r)) assert.ok(SYSTEM_PROMPT.includes(texto), `el bloque ${k} debe estar tal cual en el prompt`);
});

// ── Lo publicado llega al prompt ─────────────────────────────────────────────────────────────────
test('un bloque editado reemplaza al original, y al final quedan mandando las reglas', () => {
  const nuevo = 'asesor académico, clases en vivo con docentes, grabaciones y biblioteca digital 24/7.';
  _fijarPublicadaParaPruebas('comportamiento', conCambio({ incluyePrograma: nuevo }));
  const p = promptVigente(SYSTEM_PROMPT);
  assert.ok(p.includes(`QUÉ INCLUYE EL PROGRAMA: ${nuevo}`));
  assert.ok(!p.includes(INCLUYE_DEFECTO));
  assert.ok(p.endsWith(ac.PREVALECEN_LAS_REGLAS));
  assert.ok(p.includes('DERIVAR ES INTERNO'), 'las reglas fijas siguen ahí');
});

test('los costos de Precios llegan al prompt y a la política de devolución, sin el recordatorio', () => {
  publicarPrecios({ titulacionUsd: 140, inscripcionUsd: 180, retiroUsd: 35 });
  const p = promptVigente(SYSTEM_PROMPT);
  assert.ok(p.includes('- Titulación al finalizar: USD 140.'));
  assert.ok(p.includes('USD 180, no reembolsable'));
  assert.ok(p.includes('se devuelve todo menos los USD 180 de inscripción'));
  assert.ok(!p.includes('USD 150'), 'no queda la cifra vieja en ninguna parte');
  assert.ok(!p.includes(ac.PREVALECEN_LAS_REGLAS), 'cambiar un monto no es editar un bloque');
});

test('la cotización trae los costos publicados cuando la persona los pregunta', () => {
  publicarPrecios({ titulacionUsd: 140, inscripcionUsd: 180, retiroUsd: 35 });
  const r: any = buscarCondicionesCarver('Maestría en Psicología', { incluirCostosAdicionales: true });
  assert.deepEqual(r.costosAdicionales, { titulacionUsd: 140, inscripcionUsd: 180, retiroUsd: 35 });
});

test('un texto con "$" no se interpreta como patrón al reemplazar', () => {
  _fijarPublicadaParaPruebas('comportamiento', conCambio({ incluyePrograma: 'asesor académico y todo lo $& que necesite.' }));
  assert.ok(promptVigente(SYSTEM_PROMPT).includes('asesor académico y todo lo $& que necesite.'));
});

test('un prompt sin estos bloques (otra marca) no se toca', () => {
  _fijarPublicadaParaPruebas('comportamiento', conCambio({ incluyePrograma: 'otra cosa.' }));
  assert.equal(promptVigente('Eres Sofía, asesora de Postgrados.'), 'Eres Sofía, asesora de Postgrados.');
});

// ── Reglas ───────────────────────────────────────────────────────────────────────────────────────
test('no se aceptan montos, enlaces ni marcadores desconocidos', () => {
  assert.ok(errores(conCambio({ objecionesFrecuentes: '"está caro" → ofrece USD 900 al contado.' })).some((e) => e.campo === 'objecionesFrecuentes'));
  assert.ok(errores(conCambio({ incluyePrograma: 'biblioteca en https://biblioteca.carver.university' })).some((e) => e.campo === 'incluyePrograma'));
  assert.ok(errores(conCambio({ incluyePrograma: 'hola {nombre}' })).some((e) => e.campo === 'incluyePrograma'));
  const devolucion = errores(conCambio({ politicaDevolucion: '- Se devuelve todo menos los USD 150 de inscripción.' }));
  assert.match(devolucion.find((e) => e.campo === 'politicaDevolucion')!.mensaje, /\{inscripcion\}/);
});

test('la plantilla del título necesita {país} y {entidad}, y ningún bloque puede quedar vacío', () => {
  assert.ok(errores(conCambio({ plantillaTitulo: 'Carver otorga títulos oficiales con apostilla, válidos en {país}.' })).some((e) => /\{entidad\}/.test(e.mensaje)));
  assert.ok(errores(conCambio({ objecionesFrecuentes: '   ' })).some((e) => e.campo === 'objecionesFrecuentes'));
});

// ── Vista previa del panel ───────────────────────────────────────────────────────────────────────
test('la vista muestra la política de devolución con la inscripción de Precios', async () => {
  publicarPrecios({ titulacionUsd: 125, inscripcionUsd: 175, retiroUsd: 35 });
  const res: any = { statusCode: 200 };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: any) => ((res.cuerpo = b), res);
  await panelVistaComportamiento({ body: { contenido: ac.comportamientoPorDefecto() } } as any, res);
  assert.equal(res.statusCode, 200);
  assert.match(res.cuerpo.bloques.politicaDevolucion, /menos los USD 175 de inscripción/);
});
