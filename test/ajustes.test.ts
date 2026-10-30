import { test } from 'node:test';
import assert from 'node:assert/strict';

// Panel de configuración, sección Horarios: lo que edita alguien que no programa tiene que validarse
// con mensajes que se entiendan, y el bot tiene que seguir funcionando igual mientras nadie publique.
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

const { config } = await import('../src/config');
const { validarHorarios, horarios, horariosPorDefecto, refrescarAjustes, _fijarPublicadaParaPruebas } = await import('../src/core/ajustes');
const { asesoresDisponibles, vistaSemanal } = await import('../src/core/horarioAsesores');
const { delayHumanoMs } = await import('../src/core/ritmoHumano');

const valido = () => ({
  asesoresActivo: true,
  asesoresDias: [5, 1, 3, 1, 2, 4],
  asesoresInicio: '09:00',
  asesoresFin: '18:30',
  feriados: [
    { fecha: '2026-12-25', nombre: 'Navidad' },
    { fecha: '2026-11-01', nombre: ' Todos los Santos ' },
  ],
  ritmoMinS: 1,
  ritmoMaxS: 20,
  automaticosHoraInicio: 9,
  automaticosHoraFin: 21,
});

const errorDe = (r: any, campo: string) => (r.ok ? undefined : r.errores.find((e: any) => e.campo === campo)?.mensaje);

test('horarios: un contenido válido se normaliza (días sin repetir y ordenados, feriados por fecha)', () => {
  const r = validarHorarios(valido());
  assert.ok(r.ok);
  assert.deepEqual(r.valor.asesoresDias, [1, 2, 3, 4, 5]);
  assert.deepEqual(r.valor.feriados.map((f) => f.fecha), ['2026-11-01', '2026-12-25']);
  assert.equal(r.valor.feriados[0].nombre, 'Todos los Santos');
});

test('horarios: los errores dicen qué corregir, en palabras', () => {
  const casos: Array<[Record<string, unknown>, string, RegExp]> = [
    [{ asesoresFin: '08:00' }, 'asesoresFin', /posterior a la de inicio/],
    [{ asesoresInicio: '9' }, 'asesoresInicio', /formato 09:00/],
    [{ asesoresDias: [] }, 'asesoresDias', /al menos un día/],
    [{ asesoresDias: [7] }, 'asesoresDias', /no son válidos/],
    [{ feriados: [{ fecha: '2026-02-30' }] }, 'feriados', /no es una fecha válida/],
    [{ feriados: [{ fecha: '2026-09-18' }, { fecha: '2026-09-18' }] }, 'feriados', /repetida/],
    [{ ritmoMinS: 30, ritmoMaxS: 10 }, 'ritmoMinS', /no puede ser mayor/],
    [{ ritmoMaxS: 90 }, 'ritmoMaxS', /entre 0 y 60/],
    [{ ritmoMaxS: 2.5 }, 'ritmoMaxS', /entero/],
    [{ automaticosHoraInicio: 21, automaticosHoraFin: 9 }, 'automaticosHoraFin', /posterior a la de inicio/],
    [{ asesoresActivo: 'si' }, 'asesoresActivo', /Indica si/],
  ];
  for (const [cambio, campo, esperado] of casos) {
    const r = validarHorarios({ ...valido(), ...cambio });
    assert.equal(r.ok, false, `debió rechazar ${JSON.stringify(cambio)}`);
    assert.match(errorDe(r, campo) ?? '', esperado, `mensaje para ${JSON.stringify(cambio)}`);
  }
});

test('horarios: sin días con asesores es válido si el horario está desactivado', () => {
  assert.ok(validarHorarios({ ...valido(), asesoresActivo: false, asesoresDias: [] }).ok);
});

test('horarios: mientras nadie publique, el bot usa exactamente lo de Railway', () => {
  _fijarPublicadaParaPruebas('horarios', null);
  const antes = config.horarioAsesoresInicio;
  config.horarioAsesoresInicio = '08:15';
  try {
    assert.equal(horarios().asesoresInicio, '08:15', 'se lee config en cada llamada, no una copia vieja');
    assert.deepEqual(horarios(), horariosPorDefecto());
  } finally {
    config.horarioAsesoresInicio = antes;
  }
});

test('horarios: lo publicado manda, y una versión sin un campo nuevo se completa con el valor por defecto', async () => {
  const { automaticosHoraFin: _sinEsteCampo, ...viejo } = validarHorarios(valido()).ok ? (validarHorarios(valido()) as any).valor : {};
  await refrescarAjustes(async () => [{ seccion: 'horarios', contenido: { ...viejo, asesoresInicio: '10:00' } }]);
  assert.equal(horarios().asesoresInicio, '10:00');
  assert.equal(horarios().automaticosHoraFin, config.seguimientoHoraFin);
  _fijarPublicadaParaPruebas('horarios', null);
});

test('horarios: si la base no responde se conserva lo último publicado; si no hay nada publicado, vuelve lo de Railway', async () => {
  await refrescarAjustes(async () => [{ seccion: 'horarios', contenido: { ...valido(), asesoresInicio: '10:00' } }]);
  await refrescarAjustes(async () => null);
  assert.equal(horarios().asesoresInicio, '10:00', 'un corte de la base no devuelve el bot a valores viejos');
  await refrescarAjustes(async () => []);
  assert.deepEqual(horarios(), horariosPorDefecto());
});

test('horarios: una versión publicada que ya no es válida se ignora en vez de romper el bot', async () => {
  await refrescarAjustes(async () => [{ seccion: 'horarios', contenido: { ...valido(), asesoresFin: '07:00' } }]);
  assert.deepEqual(horarios(), horariosPorDefecto());
  await refrescarAjustes(async () => [{ seccion: 'seccion-que-no-existe', contenido: {} }]);
  assert.deepEqual(horarios(), horariosPorDefecto());
});

test('feriados: en un feriado no hay asesores y el bot atiende, aunque sea día hábil', () => {
  const h = (validarHorarios(valido()) as any).valor;
  // Lunes 2 de noviembre de 2026, 11:00 en Chile (UTC-3).
  const lunes11 = new Date('2026-11-02T14:00:00Z');
  assert.equal(asesoresDisponibles(lunes11, h), true);
  assert.equal(asesoresDisponibles(lunes11, { ...h, feriados: [{ fecha: '2026-11-02', nombre: 'Prueba' }] }), false);
});

test('vista semanal: siete días seguidos, con feriados y días sin asesores en palabras', () => {
  const h = (validarHorarios({ ...valido(), feriados: [{ fecha: '2026-11-04', nombre: 'Prueba' }] }) as any).valor;
  // Domingo 1 de noviembre de 2026, 23:30 en Chile: anclar al mediodía evita saltar o repetir días.
  const dias = vistaSemanal(h, new Date('2026-11-02T02:30:00Z'));
  assert.deepEqual(
    dias.map((d) => d.fecha),
    ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'],
  );
  assert.equal(dias[0].asesores, null, 'domingo sin asesores');
  assert.deepEqual(dias[1].asesores, { inicio: '09:00', fin: '18:30' });
  assert.equal(dias[3].feriado, 'Prueba');
  assert.equal(dias[3].asesores, null);
  assert.ok(vistaSemanal({ ...h, asesoresActivo: false }).every((d) => d.asesores === null));
});

test('ritmo de respuesta: la espera sale de lo publicado', () => {
  const h = (validarHorarios({ ...valido(), ritmoMinS: 0, ritmoMaxS: 0 }) as any).valor;
  _fijarPublicadaParaPruebas('horarios', h);
  assert.equal(delayHumanoMs(), 0, 'con máximo 0 responde de inmediato');
  _fijarPublicadaParaPruebas('horarios', { ...h, ritmoMinS: 3, ritmoMaxS: 3 });
  assert.equal(delayHumanoMs(), 3000);
  _fijarPublicadaParaPruebas('horarios', null);
});
