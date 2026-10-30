import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Sección "Conocimiento institucional" del panel de configuración (Carver). Lo más importante: mientras
// nadie publique, la herramienta del bot responde EXACTAMENTE lo mismo que con el archivo.
process.env.MARCA = 'carver';
process.env.REDIS_URL = '';
process.env.NODE_ENV = 'test';

const ac = await import('../src/core/ajustesConocimiento');
const { _fijarPublicadaParaPruebas, seccionesDisponibles } = await import('../src/core/ajustes');
const { BASE_CONOCIMIENTO, consultarInformacionInstitucional, conocimientoVigente } = await import('../src/core/conocimientoComercial');

const HOY = { hoy: new Date('2026-10-30T12:00:00Z') };

beforeEach(() => _fijarPublicadaParaPruebas('conocimiento', null));

/** Valores por defecto con un tema modificado. */
function con(tema: string, cambio: (t: any) => any) {
  const d = ac.conocimientoPorDefecto();
  return { temas: { ...d.temas, [tema]: cambio(structuredClone(d.temas[tema])) } };
}
const publicar = (contenido: unknown) => {
  const v = ac.validarConocimiento(contenido);
  assert.ok(v.ok, `la versión de prueba debe ser válida: ${JSON.stringify(!v.ok && v.errores)}`);
  _fijarPublicadaParaPruebas('conocimiento', v.valor);
};
const errores = (contenido: unknown) => {
  const v = ac.validarConocimiento(contenido);
  return v.ok ? [] : v.errores;
};

// ── Sin publicar, nada cambia ────────────────────────────────────────────────────────────────────
test('se editan seis temas; medios de pago queda fuera', () => {
  assert.deepEqual(Object.keys(ac.conocimientoPorDefecto().temas).sort(), [
    'argumentos_venta',
    'calendario_ingresos',
    'datos_operativos',
    'proceso_admision',
    'prueba_social',
    'reconocimiento_titulo',
  ]);
  assert.ok(seccionesDisponibles().includes('conocimiento'));
});

test('los valores por defecto cumplen las reglas, y validarlos no cambia nada', () => {
  const v = ac.validarConocimiento(ac.conocimientoPorDefecto());
  assert.ok(v.ok, JSON.stringify(!v.ok && v.errores));
  // Pasar por la validación (renumerar pasos, quitar opcionales vacíos) deja la base idéntica: si no,
  // publicar sin tocar nada cambiaría lo que responde el bot.
  assert.deepEqual(ac.aplicarAjustesAConocimiento(BASE_CONOCIMIENTO, v.valor), BASE_CONOCIMIENTO);
});

test('sin publicar, la base vigente es la del archivo', () => {
  assert.deepEqual(conocimientoVigente(), BASE_CONOCIMIENTO);
});

// ── Reglas ───────────────────────────────────────────────────────────────────────────────────────
test('un tema activo necesita fuente (sin fuente el bot no lo usaría)', () => {
  const e = errores(con('argumentos_venta', (t) => ({ ...t, fuente: '' })));
  assert.ok(e.some((x) => x.campo === 'temas.argumentos_venta.fuente'));
  assert.deepEqual(errores(con('argumentos_venta', (t) => ({ ...t, fuente: '', activo: false }))), [], 'desactivado, puede no tenerla');
});

test('calendario: dos fechas para el mismo ciclo, o cierre después del inicio, se rechazan', () => {
  const duplicado = errores(
    con('calendario_ingresos', (t) => ({ ...t, entradas: [...t.entradas, { ...t.entradas[0], inicioClases: '2026-08-31' }] })),
  );
  assert.ok(duplicado.some((x) => /^temas\.calendario_ingresos\.entradas\.\d+\.inicioClases$/.test(x.campo)));
  const alReves = errores(con('calendario_ingresos', (t) => ({ ...t, entradas: [{ ...t.entradas[0], cierrePostulacion: '2026-09-30' }] })));
  assert.ok(alReves.some((x) => x.campo === 'temas.calendario_ingresos.entradas.0.cierrePostulacion'));
});

test('campos obligatorios, fechas y enlaces se validan fila por fila', () => {
  const e = errores(
    con('prueba_social', (t) => ({ ...t, entradas: [{ titulo: 'x', texto: '', enlace: 'http://inseguro.com' }] })),
  );
  assert.ok(e.some((x) => x.campo === 'temas.prueba_social.entradas.0.texto'));
  assert.ok(e.some((x) => x.campo === 'temas.prueba_social.entradas.0.enlace'));
});

test('un opcional vacío no se guarda, y los pasos se numeran según el orden', () => {
  const v = ac.validarConocimiento(
    con('proceso_admision', (t) => ({ ...t, entradas: [t.entradas[2], t.entradas[0]] })),
  );
  assert.ok(v.ok);
  assert.deepEqual(v.valor.temas.proceso_admision.entradas.map((x) => x.paso), [1, 2]);
  const w = ac.validarConocimiento(con('datos_operativos', (t) => ({ ...t, entradas: [{ tema: 'a', respuesta: 'b', instruccionInterna: '  ' }] })));
  assert.ok(w.ok);
  assert.equal('instruccionInterna' in w.valor.temas.datos_operativos.entradas[0], false);
});

// ── Lo publicado llega al bot ────────────────────────────────────────────────────────────────────
test('un ciclo nuevo publicado aparece en la herramienta del bot', () => {
  publicar(
    con('calendario_ingresos', (t) => ({
      ...t,
      entradas: [...t.entradas, { ciclo: 'C99PRUEBA', programa: 'todos', inicioClases: '2027-12-06', cierrePostulacion: '2027-12-03' }],
    })),
  );
  const r = consultarInformacionInstitucional('calendario_ingresos', HOY);
  assert.ok(r.ok && r.disponible);
  assert.ok(r.contenido.some((x) => x.ciclo === 'C99PRUEBA'));
});

test('un tema desactivado o vencido deja de usarse, y el bot dice que no tiene el dato', () => {
  publicar(con('prueba_social', (t) => ({ ...t, activo: false })));
  const desactivado = consultarInformacionInstitucional('prueba_social', HOY);
  assert.ok(desactivado.ok && !desactivado.disponible);
  assert.equal(!desactivado.disponible && desactivado.motivo, 'pendiente_de_validacion');

  publicar(con('datos_operativos', (t) => ({ ...t, vigenteHasta: '2026-01-31' })));
  const vencido = consultarInformacionInstitucional('datos_operativos', HOY);
  assert.ok(vencido.ok && !vencido.disponible);
  assert.equal(!vencido.disponible && vencido.motivo, 'vencido');
});

test('un país corregido en el panel es lo que responde el bot', () => {
  publicar(
    con('reconocimiento_titulo', (t) => ({
      ...t,
      entradas: t.entradas.map((x: any) => (/Colombia/i.test(x.pais) ? { ...x, puedeAfirmar: 'Texto revisado por admisión.' } : x)),
    })),
  );
  const r = consultarInformacionInstitucional('reconocimiento_titulo', HOY);
  assert.ok(r.ok && r.disponible);
  assert.equal(r.contenido.find((x) => /Colombia/i.test(String(x.pais)))?.puedeAfirmar, 'Texto revisado por admisión.');
});

test('publicar conocimiento no toca los medios de pago', () => {
  publicar(con('argumentos_venta', (t) => ({ ...t, entradas: t.entradas.slice(0, 2) })));
  assert.deepEqual(conocimientoVigente().temas.medios_de_pago, BASE_CONOCIMIENTO.temas.medios_de_pago);
  assert.deepEqual(consultarInformacionInstitucional('medios_de_pago', HOY), consultarInformacionInstitucional('medios_de_pago', HOY, BASE_CONOCIMIENTO));
});
