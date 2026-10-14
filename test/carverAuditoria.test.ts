import { test } from 'node:test';
import assert from 'node:assert/strict';

// Regresiones de la auditoría del piloto de Carver (octubre 2026): oferta autorizada, brochure
// verificado, base de conocimiento, equipo y traspaso por sesión. Todo sin red ni Bitrix.
process.env.MARCA = 'carver';
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.BITRIX_DERIVAR_A = '1313';
process.env.BITRIX_EMBUDOS_PROPIOS = '73,135';

const { consultarProgramas, detallePrograma } = await import('../src/core/catalogTool');
const { WHATSAPP_PROFILE } = await import('../src/core/channel');
const { PROGRAMAS } = await import('../src/ai/catalog');
const { marca } = await import('../src/marca');
const { config } = await import('../src/config');
const { obtenerBrochure, archivoCorrespondeAPrograma, _limpiarCacheBrochures } = await import('../src/core/brochures');
const { consultarInformacionInstitucional, BASE_CONOCIMIENTO, estadoTemas, TEMAS } = await import('../src/core/conocimientoComercial');
const { perteneceAlEquipo, esAsesorValido } = await import('../src/crm/equipo');
const { sesionOpenLines, marcarTraspaso, traspasoVigente } = await import('../src/session');

// ── Hallazgo 1: identidad ─────────────────────────────────────────────────────────────────────────
test('identidad: Carver no usa una persona inventada; el nombre registrado es institucional', () => {
  assert.equal(marca.botNombreRegistro, 'Carver University');
  assert.doesNotMatch(marca.botNombreRegistro, /Sof[ií]a/);
  assert.doesNotMatch(marca.presentacionSinAsesor, /Sof[ií]a/);
  assert.match(marca.presentacionSinAsesor, /equipo de admisiones de Carver University/);
});

test('identidad: ningún texto del canal de Carver se presenta como "Sofía"', () => {
  assert.doesNotMatch(WHATSAPP_PROFILE.systemPrompt, /Sof[ií]a/);
});

// ── Hallazgo 6: NOOCs fuera de la oferta, sin borrar la historia ─────────────────────────────────
test('oferta: el catálogo histórico conserva los 22 cursos, pero la búsqueda no los devuelve', () => {
  assert.equal(PROGRAMAS.filter((p) => p.tipo === 'curso').length, 22, 'no se borra información histórica');
  const todo: any = consultarProgramas({}, { ...WHATSAPP_PROFILE.catalog.consultar, limit: 100 });
  assert.equal(todo.total, 16, '3 licenciaturas + 13 maestrías');
  assert.ok(todo.programas.every((p: any) => p.tipo === 'licenciatura' || p.tipo === 'maestria'));
});

test('oferta: buscar un NOOC por nombre o pedir "curso" no devuelve ningún curso', () => {
  // Puede devolver una maestría relacionada (p. ej. por la palabra "ético" en su descripción): eso
  // está bien, es la alternativa que sí se ofrece. Lo que nunca debe aparecer es el curso.
  for (const q of [{ texto: 'Hacking ético' }, { texto: 'Personal Branding' }, { tipo: 'curso' }]) {
    const r: any = consultarProgramas(q, WHATSAPP_PROFILE.catalog.consultar);
    assert.ok(r.programas.every((p: any) => p.tipo !== 'curso'), JSON.stringify(q));
    assert.ok(!r.programas.some((p: any) => /hacking|personal branding/i.test(p.nombre)), JSON.stringify(q));
  }
  assert.equal((consultarProgramas({ tipo: 'curso' }, WHATSAPP_PROFILE.catalog.consultar) as any).total, 0);
});

test('oferta: el detalle de un NOOC se niega como no comercializable', () => {
  const r: any = detallePrograma({ nombre: 'Hacking ético' }, 'full');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'NO_COMERCIALIZABLE');
});

// ── Hallazgo 2: brochure verificado ──────────────────────────────────────────────────────────────
test('brochure: el detalle de una maestría ya no expone el enlace sin verificar', () => {
  const r: any = detallePrograma({ nombre: 'Maestría en Inteligencia Artificial' }, 'full');
  assert.equal(r.ok, true);
  assert.equal(r.detalle.brochureUrl, undefined);
  assert.match(r.nota_brochure, /obtener_brochure/);
});

const respuesta = (status: number, tipo: string, cuerpo: string | Buffer) =>
  ({
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? tipo : null) },
    text: async () => String(cuerpo),
    arrayBuffer: async () => (Buffer.isBuffer(cuerpo) ? cuerpo : Buffer.from(cuerpo)),
  }) as any;

test('brochure: un visor de Bitrix cuyo archivo es el del programa se entrega como visor de PDF', async () => {
  _limpiarCacheBrochures();
  const f = async () => respuesta(200, 'text/html; charset=UTF-8', '<html><title>BR-Maestría en Inteligencia Artificial.pdf</title></html>');
  const r = await obtenerBrochure({ programa: 'Maestría en Inteligencia Artificial' }, f as any);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.formato, 'visor_pdf');
    assert.match(r.url, /^https:\/\//);
  }
});

test('brochure: un PDF directo válido se entrega como pdf', async () => {
  _limpiarCacheBrochures();
  const f = async () => respuesta(200, 'application/pdf', Buffer.from('%PDF-1.7 ...'));
  const r = await obtenerBrochure({ programa: 'Maestría en Psicología' }, f as any);
  assert.equal(r.ok && r.formato, 'pdf');
});

test('brochure: si el archivo detrás del enlace es de OTRO programa, no se entrega', async () => {
  _limpiarCacheBrochures();
  const f = async () => respuesta(200, 'text/html', '<title>BR-Licenciatura en Psicología.pdf</title>');
  const r = await obtenerBrochure({ programa: 'Maestría en Ingeniería' }, f as any);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.motivo, 'no_corresponde_al_programa');
});

test('brochure: enlace caído, página que no es PDF o error de red → no se entrega ningún enlace', async () => {
  const casos: Array<[any, string]> = [
    [async () => respuesta(404, 'text/html', 'no existe'), 'http_404'],
    [async () => respuesta(200, 'text/html', '<title>Iniciar sesión</title>'), 'no_es_pdf'],
    [async () => respuesta(200, 'application/pdf', Buffer.from('<html>')), 'pdf_corrupto'],
    [async () => { throw new Error('getaddrinfo ENOTFOUND'); }, 'error_red'],
  ];
  for (const [f, motivo] of casos) {
    _limpiarCacheBrochures();
    const r = await obtenerBrochure({ programa: 'Maestría en Salud Mental' }, f);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.motivo, motivo);
  }
});

test('brochure: un NOOC no tiene brochure que entregar', async () => {
  _limpiarCacheBrochures();
  const r = await obtenerBrochure({ programa: 'Hacking ético' }, (async () => respuesta(200, 'application/pdf', Buffer.from('%PDF-'))) as any);
  assert.equal(!r.ok && r.motivo, 'programa_no_comercializable');
});

test('brochure: la correspondencia archivo↔programa tolera prefijos y tildes, no programas distintos', () => {
  assert.equal(archivoCorrespondeAPrograma('BR-Maestría en Inteligencia Artificial.pdf', 'Maestría en Inteligencia Artificial'), true);
  assert.equal(archivoCorrespondeAPrograma('BR-Maestria en Administracion de Empresas.pdf', 'Maestría en Administración de Empresas MBA'), true);
  assert.equal(archivoCorrespondeAPrograma('BR-Maestría en Psicología.pdf', 'Licenciatura en Psicología'), true, 'la palabra genérica no decide');
  assert.equal(archivoCorrespondeAPrograma('BR-Maestría en Salud Mental.pdf', 'Maestría en Ingeniería'), false);
});

// ── Etapa 4: base de conocimiento verificable ────────────────────────────────────────────────────
test('conocimiento: lo validado se entrega y lo pendiente se declara faltante', () => {
  // Antes esta prueba afirmaba que los CUATRO temas estaban sin validar. Eso era una foto del dato,
  // no una regla: al cargarlos con los documentos de la dirección quedó en rojo sin que nada se
  // hubiera roto. Lo que debe sostenerse es la regla, tema por tema según su estado real.
  assert.equal(estadoTemas().length, TEMAS.length, 'el informe cubre todos los temas');
  for (const e of estadoTemas()) {
    const r: any = consultarInformacionInstitucional(e.tema);
    assert.equal(r.ok, true);
    if (e.estado === 'validado') {
      // Un tema validado debe declarar de dónde salió: sin fuente no se entrega.
      assert.ok(e.fuente, `${e.tema} validado sin fuente`);
      assert.ok(e.vigenteHasta, `${e.tema} validado sin fecha de vigencia`);
    } else {
      assert.equal(r.disponible, false, e.tema);
      assert.match(r.instruccion, /NO lo inventes/);
    }
  }
});

test('un tema sin validar nunca se entrega, aunque tenga entradas cargadas', () => {
  // El riesgo real: cargar datos y olvidarse de validarlos, y que el bot los diga igual.
  const r: any = consultarInformacionInstitucional(
    'calendario_ingresos',
    {},
    base({
      calendario_ingresos: tema({
        estado: 'pendiente',
        entradas: [{ ciclo: 'C01', programa: 'todos', inicioClases: '2099-01-01', cierrePostulacion: '2098-12-28' }],
      }),
    }) as any,
  );
  assert.equal(r.disponible, false);
  assert.equal(r.motivo, 'pendiente_de_validacion');
});

const base = (temas: Record<string, any>) => ({ temas });
const tema = (extra: Record<string, any>) => ({
  titulo: 't',
  estado: 'validado',
  fuente: 'Dirección comercial, correo del 2026-10-20',
  responsable: 'Dirección',
  vigenteHasta: '2026-12-31',
  actualizado: '2026-10-20',
  camposObligatorios: ['ciclo', 'programa', 'inicioClases', 'cierrePostulacion'],
  entradas: [],
  ...extra,
});
const hoy = new Date('2026-10-21T12:00:00Z');

test('conocimiento: un calendario validado y vigente se entrega con su fuente', () => {
  const b = base({
    calendario_ingresos: tema({ entradas: [{ ciclo: '2026-2', programa: 'todos', inicioClases: '2026-11-09', cierrePostulacion: '2026-11-02' }] }),
  });
  const r: any = consultarInformacionInstitucional('calendario_ingresos', { hoy }, b as any);
  assert.equal(r.disponible, true);
  assert.equal(r.contenido[0].inicioClases, '2026-11-09');
  assert.match(r.fuente, /Dirección comercial/);
});

test('conocimiento: vencido, incompleto, contradictorio o sin fuente → no disponible', () => {
  const vencido = base({ calendario_ingresos: tema({ vigenteHasta: '2026-10-01', entradas: [{ ciclo: 'a', programa: 'todos', inicioClases: '2026-11-09', cierrePostulacion: '2026-11-02' }] }) });
  assert.equal((consultarInformacionInstitucional('calendario_ingresos', { hoy }, vencido as any) as any).motivo, 'vencido');

  const pasado = base({ calendario_ingresos: tema({ entradas: [{ ciclo: 'a', programa: 'todos', inicioClases: '2026-10-01', cierrePostulacion: '2026-09-20' }] }) });
  assert.equal((consultarInformacionInstitucional('calendario_ingresos', { hoy }, pasado as any) as any).motivo, 'vencido', 'un ciclo que ya empezó no es el próximo');

  const incompleto = base({ calendario_ingresos: tema({ entradas: [{ ciclo: 'a', programa: 'todos' }] }) });
  assert.equal((consultarInformacionInstitucional('calendario_ingresos', { hoy }, incompleto as any) as any).motivo, 'incompleto');

  const contradictorio = base({
    calendario_ingresos: tema({
      entradas: [
        { ciclo: 'a', programa: 'todos', inicioClases: '2026-11-09', cierrePostulacion: '2026-11-02' },
        { ciclo: 'a', programa: 'todos', inicioClases: '2026-11-16', cierrePostulacion: '2026-11-02' },
      ],
    }),
  });
  assert.equal((consultarInformacionInstitucional('calendario_ingresos', { hoy }, contradictorio as any) as any).motivo, 'contradictorio');

  const sinFuente = base({ calendario_ingresos: tema({ fuente: null, entradas: [{ ciclo: 'a', programa: 'todos', inicioClases: '2026-11-09', cierrePostulacion: '2026-11-02' }] }) });
  assert.equal((consultarInformacionInstitucional('calendario_ingresos', { hoy }, sinFuente as any) as any).motivo, 'sin_fuente');
});

test('conocimiento: el enlace de postulación es el del asesor de ESTE caso, nunca el de otro', () => {
  const b = base({
    enlace_postulacion: tema({
      camposObligatorios: ['asesorId', 'asesor', 'url'],
      entradas: [
        { asesorId: 685357, asesor: 'Asesor A', url: 'https://apply.example/a' },
        { asesorId: 685355, asesor: 'Asesor B', url: 'https://apply.example/b' },
      ],
    }),
  });
  const a: any = consultarInformacionInstitucional('enlace_postulacion', { hoy, asesorId: 685357 }, b as any);
  assert.equal(a.contenido[0].url, 'https://apply.example/a');
  const sinAsesor: any = consultarInformacionInstitucional('enlace_postulacion', { hoy, asesorId: null }, b as any);
  assert.equal(sinAsesor.motivo, 'sin_asesor_asignado');
  const otro: any = consultarInformacionInstitucional('enlace_postulacion', { hoy, asesorId: 999 }, b as any);
  assert.equal(otro.motivo, 'sin_enlace_para_el_asesor');
});

test('conocimiento: un tema desconocido se rechaza', () => {
  assert.equal((consultarInformacionInstitucional('becas_secretas') as any).error, 'TEMA_DESCONOCIDO');
});

// ── Hallazgo 9: equipo de la marca ───────────────────────────────────────────────────────────────
test('equipo: los departamentos verificados de Carver están configurados por defecto', () => {
  assert.deepEqual(config.equipoDepartamentos, [193, 509, 511]);
  assert.deepEqual(config.estudiantesCategorias, [107]);
  assert.deepEqual(config.etapasMatriculado, ['C73:WON', 'C135:WON']);
});

test('equipo: pertenece quien está en un departamento de Carver o es el punto de entrada', () => {
  assert.equal(perteneceAlEquipo({ id: 479297, departamentos: [193] }), true);
  assert.equal(perteneceAlEquipo({ id: 685357, departamentos: [511] }), true);
  assert.equal(perteneceAlEquipo({ id: 1313, departamentos: [49] }), true, 'el punto de entrada configurado');
  assert.equal(perteneceAlEquipo({ id: 9, departamentos: [5] }), false, 'un ejecutivo de otro equipo');
  assert.equal(perteneceAlEquipo({ id: 77, departamentos: [] }), false);
});

test('equipo: un robot, alguien dado de baja o de otro equipo no es un asesor válido', () => {
  assert.equal(esAsesorValido({ id: 45, departamentos: [193] }), false, 'Resp. Autom. es un robot');
  assert.equal(esAsesorValido({ id: 479297, activo: false, departamentos: [193] }), false);
  assert.equal(esAsesorValido({ id: 9, activo: true, departamentos: [5] }), false);
  assert.equal(esAsesorValido({ id: 479297, activo: true, departamentos: [193] }), true);
});

// ── Traspaso a una persona por sesión de Open Lines ──────────────────────────────────────────────
test('sesión: lee el id de sesión de CHAT_ENTITY_DATA_1 (formato real de Bitrix)', () => {
  assert.equal(sesionOpenLines('Y|DEAL|3482325|N|N|1233711|1791755708|0|0|0'), '1233711');
  assert.equal(sesionOpenLines('Y|LEAD|1|N|N|0|0'), null);
  assert.equal(sesionOpenLines(undefined), null);
});

test('sesión: tras derivar, el bot calla toda la sesión — aunque pasen más de 6 h — y vuelve en la siguiente', async () => {
  await marcarTraspaso('chat-traspaso', '1233711', 'escalado');
  assert.ok(await traspasoVigente('chat-traspaso', '1233711'), 'misma sesión: sigue en silencio');
  assert.equal(await traspasoVigente('chat-traspaso', '1240000'), null, 'sesión nueva: el bot vuelve a atender');
  assert.equal(await traspasoVigente('chat-sin-traspaso', '1233711'), null);
});

// ── Medios de pago ───────────────────────────────────────────────────────────────────────────────
// El único tema donde equivocarse cuesta dinero de verdad. La dirección entregó dos medios oficiales
// y seis enlaces de PayPal de importe fijo (50, 100, 150, 585 y 900 USD) SIN decir qué monto
// corresponde a qué programa. La regla, entonces: un enlace solo sale si no lleva monto.
const pago = (extra: Record<string, any>) => tema({ camposObligatorios: ['medio', 'descripcion'], ...extra });

test('pagos: el portal sin monto se entrega con su enlace', () => {
  const b = base({
    medios_de_pago: pago({
      entradas: [{ medio: 'Flywire', descripcion: 'Portal oficial', url: 'https://carver.university/es/portal-de-pagos/' }],
    }),
  });
  const r: any = consultarInformacionInstitucional('medios_de_pago', { hoy }, b as any);
  assert.equal(r.disponible, true);
  assert.equal(r.contenido[0].url, 'https://carver.university/es/portal-de-pagos/');
});

test('pagos: un enlace con monto fijo NUNCA se entrega, por mucho que esté cargado', () => {
  // Si alguien pega mañana los enlaces de PayPal en el JSON, el bot sigue sin poder mandarlos: sin la
  // tabla de qué monto va con qué programa, elegir uno es adivinar con la plata de otra persona.
  const b = base({
    medios_de_pago: pago({
      entradas: [
        { medio: 'PayPal', descripcion: 'Pago arancel', monto: 585, url: 'https://www.paypal.com/ncp/payment/KPUBERAA2HZ7U' },
      ],
    }),
  });
  const r: any = consultarInformacionInstitucional('medios_de_pago', { hoy }, b as any);
  assert.equal(r.disponible, true, 'el medio sí se nombra');
  assert.equal(r.contenido[0].url, undefined, 'el enlace con monto no sale');
  assert.equal(r.contenido[0].enlaceLoEnviaElAsesor, true);
  assert.equal(r.contenido[0].medio, 'PayPal');
});

test('pagos: un enlace que no es https tampoco se entrega', () => {
  const b = base({
    medios_de_pago: pago({ entradas: [{ medio: 'Otro', descripcion: 'x', url: 'http://pagos.example' }] }),
  });
  const r: any = consultarInformacionInstitucional('medios_de_pago', { hoy }, b as any);
  assert.equal(r.contenido[0].url, undefined);
  assert.equal(r.contenido[0].enlaceLoEnviaElAsesor, true);
});

test('pagos: con los datos reales de Carver, ningún enlace entregado lleva monto', () => {
  const r: any = consultarInformacionInstitucional('medios_de_pago');
  assert.equal(r.disponible, true, 'el tema está cargado y validado');
  for (const e of r.contenido) {
    if (e.url) {
      assert.match(e.url, /^https:\/\//);
      assert.equal(e.monto, undefined, `${e.medio} entrega un enlace con monto`);
      assert.doesNotMatch(e.url, /paypal/i, 'ningún enlace de PayPal se entrega');
    }
  }
  // PayPal se nombra, pero sin enlace y advirtiendo la comisión.
  const pp = r.contenido.find((e: any) => e.medio === 'PayPal');
  assert.ok(pp, 'PayPal es uno de los dos medios oficiales');
  assert.equal(pp.url, undefined);
  assert.match(pp.descripcion, /comisión/i);
});
