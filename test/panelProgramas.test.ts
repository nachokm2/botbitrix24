import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Panel de configuración, secciones "Programas y modalidad" y "Precios" (Carver): la vista previa de
// precios, la prueba del brochure y el recorrido guardar → publicar → el bot cotiza con lo nuevo.
process.env.MARCA = 'carver';
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';
process.env.BITRIX_PORTAL_DOMAIN = 'uachile.bitrix24.es';
process.env.PANEL_EDITORES = '4173';
process.env.PANEL_SECRETO = 'x'.repeat(40);

mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: async () => ({ ID: '4173', NAME: 'Rodrigo', LAST_NAME: 'Palma' }),
    callCrm: async () => ({}),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: {}, total: 0 }),
    callWebhook: async () => ({}),
  },
});

// Base en memoria con el mismo contrato que store/db.ts.
type V = { id: number; seccion: string; estado: string; contenido: any; autorNombre: string; publicadaEn: string | null; publicadaPor: string | null };
let filas: V[] = [];
let siguienteId = 1;
mock.module('../src/store/db.ts', {
  namedExports: {
    dbConfigPublicadas: async () => filas.filter((f) => f.estado === 'publicada').map((f) => ({ seccion: f.seccion, contenido: f.contenido })),
    dbConfigSeccion: async (s: string) => ({
      publicada: filas.find((f) => f.seccion === s && f.estado === 'publicada') ?? null,
      borrador: filas.find((f) => f.seccion === s && f.estado === 'borrador') ?? null,
      historial: filas.filter((f) => f.seccion === s && f.estado !== 'borrador').reverse(),
    }),
    dbConfigVersion: async () => null,
    dbConfigGuardarBorrador: async (s: string, contenido: any, autor: any, previo: number | null) => {
      const actual = filas.find((f) => f.seccion === s && f.estado === 'borrador');
      if ((actual?.id ?? null) !== previo) return { ok: false, motivo: 'conflicto' };
      filas = filas.filter((f) => f !== actual);
      const v: V = { id: siguienteId++, seccion: s, estado: 'borrador', contenido, autorNombre: autor.nombre, publicadaEn: null, publicadaPor: null };
      filas.push(v);
      return { ok: true, version: v };
    },
    dbConfigDescartarBorrador: async () => ({ ok: false, motivo: 'conflicto' }),
    dbConfigPublicar: async (s: string, id: number, _nota: string, quien: any) => {
      const b = filas.find((f) => f.seccion === s && f.estado === 'borrador' && f.id === id);
      if (!b) return { ok: false, motivo: 'conflicto' };
      for (const f of filas) if (f.seccion === s && f.estado === 'publicada') f.estado = 'archivada';
      Object.assign(b, { estado: 'publicada', publicadaEn: new Date().toISOString(), publicadaPor: quien.nombre });
      return { ok: true, version: b };
    },
    dbInsertAudit: async () => {},
  },
});

const { panelPagina, panelLeerSeccion, panelGuardarBorrador, panelPublicar, panelVistaPrecios, panelVerificarBrochure, panelVistaConocimiento } = await import('../src/routes/panelConfig');
const { conocimientoPorDefecto } = await import('../src/core/ajustesConocimiento');
const { preciosPorDefecto, programasBase } = await import('../src/core/ajustesProgramas');
const { buscarCondicionesCarver } = await import('../src/core/condicionesCarver');
const { _limpiarCacheBrochures } = await import('../src/core/brochures');

function respuesta() {
  const r: any = { statusCode: 200, headers: {} as Record<string, string>, locals: { editor: { id: 4173, nombre: 'Rodrigo Palma' } }, cuerpo: undefined };
  r.status = (c: number) => ((r.statusCode = c), r);
  r.json = (b: any) => ((r.cuerpo = b), r);
  r.send = (b: any) => ((r.cuerpo = b), r);
  r.set = (k: string, v: string) => ((r.headers[k.toLowerCase()] = v), r);
  return r;
}
const pedido = (p: { body?: any; query?: any; params?: any } = {}) => ({ body: p.body ?? {}, query: p.query ?? {}, params: p.params ?? {} }) as any;
const slugDe = (nombre: string) => programasBase().find((b) => b.nombre === nombre)!.slug;
const PSICO = 'Maestría en Psicología';

test('la página ofrece Programas, Precios y Conocimiento solo donde hay datos cargados (Carver)', async () => {
  const res = respuesta();
  await panelPagina(pedido({ body: { AUTH_ID: 'tok' }, query: { DOMAIN: 'uachile.bitrix24.es' } }), res);
  assert.equal(res.statusCode, 200);
  assert.match(res.cuerpo, /<meta name="panel-secciones" content="horarios,programas,precios,conocimiento">/);
});

test('conocimiento: la sección trae el esquema de cada tema para dibujar el formulario', async () => {
  const res = respuesta();
  await panelLeerSeccion(pedido({ params: { seccion: 'conocimiento' } }), res);
  assert.equal(res.cuerpo.esquema.length, 6);
  assert.ok(res.cuerpo.esquema.every((e: any) => e.campos.length && res.cuerpo.vigente.temas[e.tema]));
});

test('conocimiento: la vista dice si el bot usará cada tema, y si no, por qué', async () => {
  const d = conocimientoPorDefecto();
  const res = respuesta();
  await panelVistaConocimiento(pedido({ body: { contenido: { temas: { ...d.temas, prueba_social: { ...d.temas.prueba_social, activo: false } } } } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.cuerpo.temas.prueba_social.disponible, false);
  assert.match(res.cuerpo.temas.prueba_social.texto, /desactivado/);
  assert.equal(res.cuerpo.temas.argumentos_venta.disponible, true);
  assert.match(res.cuerpo.temas.calendario_ingresos.texto, /próximo inicio/);
});

test('vista de precios: cómo cotiza el bot y con qué medio se paga cada monto', async () => {
  const res = respuesta();
  await panelVistaPrecios(pedido({ body: { contenido: preciosPorDefecto() } }), res);
  assert.equal(res.statusCode, 200);
  const v = res.cuerpo.programas[slugDe(PSICO)];
  assert.ok(v.resumen.some((t: string) => /USD 3\.600/.test(t) && /USD 1\.800/.test(t)), 'arancel de lista y con beca');
  assert.ok(v.resumen.some((t: string) => /12 cuotas de USD 150/.test(t)));
  const medio = Object.fromEntries(v.pagos.map((p: any) => [p.concepto, `${p.montoUsd}:${p.medio}`]));
  assert.deepEqual(medio, { matricula: '50:paypal', cuota_mensual: '150:paypal', pago_semestral: '630:flywire', pago_contado: '900:paypal' });

  // Una licenciatura con cupos completos: la vista avisa que el bot lo dirá antes del precio.
  const lic = res.cuerpo.programas[slugDe('Licenciatura en Administración de Empresas')];
  assert.match(lic.resumen[0], /reabre en marzo de 2027/);
});

test('vista de precios: con datos inválidos devuelve qué corregir', async () => {
  const d = preciosPorDefecto();
  const slug = slugDe(PSICO);
  const res = respuesta();
  await panelVistaPrecios(pedido({ body: { contenido: { ...d, programas: { ...d.programas, [slug]: { ...d.programas[slug], cuotas: 7 } } } } }), res);
  assert.equal(res.statusCode, 400);
  assert.ok(res.cuerpo.errores.some((e: any) => e.campo === `programas.${slug}.cuotas`));
});

test('probar brochure: rechaza direcciones internas sin ir a buscarlas', async () => {
  const fetchOriginal = globalThis.fetch;
  let consultas = 0;
  globalThis.fetch = (async () => {
    consultas++;
    return new Response('');
  }) as typeof fetch;
  try {
    const res = respuesta();
    await panelVerificarBrochure(pedido({ body: { programa: slugDe(PSICO), url: 'https://postgres.railway.internal/x.pdf' } }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(consultas, 0);
    const otro = respuesta();
    await panelVerificarBrochure(pedido({ body: { programa: 'no-existe', url: 'https://ejemplo.org/a.pdf' } }), otro);
    assert.equal(otro.statusCode, 404);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

test('probar brochure: dice si el bot lo podrá entregar o por qué no', async () => {
  _limpiarCacheBrochures();
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (async (url: any) =>
    String(url).includes('roto')
      ? new Response('no', { status: 404, headers: { 'content-type': 'text/html' } })
      : new Response('<html><title>BR - Maestría en Contabilidad.pdf</title></html>', { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch;
  try {
    const roto = respuesta();
    await panelVerificarBrochure(pedido({ body: { programa: slugDe(PSICO), url: 'https://ejemplo.org/roto' } }), roto);
    assert.equal(roto.cuerpo.valido, false);
    assert.match(roto.cuerpo.mensaje, /404/);
    const ajeno = respuesta();
    await panelVerificarBrochure(pedido({ body: { programa: slugDe(PSICO), url: 'https://ejemplo.org/visor' } }), ajeno);
    assert.equal(ajeno.cuerpo.valido, false, 'el PDF es de otro programa');
    assert.match(ajeno.cuerpo.mensaje, /Contabilidad/);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

test('guardar y publicar precios: el bot cotiza con lo publicado', async () => {
  const d = preciosPorDefecto();
  const slug = slugDe(PSICO);
  const contenido = { ...d, programas: { ...d.programas, [slug]: { ...d.programas[slug], arancelLista: 4200 } } };

  const guardado = respuesta();
  await panelGuardarBorrador(pedido({ params: { seccion: 'precios' }, body: { contenido, borradorId: null } }), guardado);
  assert.equal(guardado.statusCode, 200);
  assert.equal(buscarCondicionesCarver(PSICO).arancelLista, 3600, 'un borrador no rige');

  const publicado = respuesta();
  await panelPublicar(pedido({ params: { seccion: 'precios' }, body: { borradorId: guardado.cuerpo.borrador.id } }), publicado);
  assert.equal(publicado.statusCode, 200);
  const r: any = buscarCondicionesCarver(PSICO);
  assert.equal(r.arancelLista, 4200);
  assert.equal(r.formasDePago.mensualidades.montoCuota, 175);

  const leido = respuesta();
  await panelLeerSeccion(pedido({ params: { seccion: 'precios' } }), leido);
  assert.equal(leido.cuerpo.vigente.programas[slug].arancelLista, 4200);
  assert.equal(leido.cuerpo.porDefecto.programas[slug].arancelLista, 3600, 'el original sigue a la vista para comparar');
});

test('un borrador de precios con cuotas que no dividen exacto no se guarda', async () => {
  const d = preciosPorDefecto();
  const slug = slugDe(PSICO);
  const res = respuesta();
  await panelGuardarBorrador(pedido({ params: { seccion: 'precios' }, body: { contenido: { ...d, programas: { ...d.programas, [slug]: { ...d.programas[slug], cuotas: 7 } } }, borradorId: null } }), res);
  assert.equal(res.statusCode, 400);
});
