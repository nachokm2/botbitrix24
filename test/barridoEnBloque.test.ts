import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectarBarridosEnBloque, type MovimientoDeal } from '../src/crm/marchaBlanca';

// PAN-19/PANX-06: la heurística de "barrido en bloque" distinguía barrido de trabajo real agrupando
// por DÍA, con lo que un asesor que mueve muchos casos a la misma etapa a lo largo de una jornada
// aparecía con 0 atendidos. Caso real (deal#3667905): Jefferson Dávila movió 37 casos a "Contactando"
// el 2026-10-21, uno cada 1–2 min entre las 14:20 y las 22:57 — trabajo individual, no un barrido.
// Ahora se agrupa por INSTANTE (ventana de 10 s): el barrido es casi simultáneo; el asesor lo espacia.

const mapa = (deals: Array<{ id: number } & MovimientoDeal>) => {
  const m = new Map<number, MovimientoDeal>();
  for (const { id, ...rest } of deals) m.set(id, rest);
  return m;
};

// Los MOVED_TIME REALES de Jefferson (685357) el 21-10, todos a C73:UC_KY8NN7 (muestra de los 37).
const JEFFERSON_REAL = [
  { id: 3668557, MOVED_TIME: '2026-10-21T14:20:37+03:00' },
  { id: 3667509, MOVED_TIME: '2026-10-21T14:21:36+03:00' },
  { id: 3667329, MOVED_TIME: '2026-10-21T14:23:05+03:00' },
  { id: 3667905, MOVED_TIME: '2026-10-21T14:46:27+03:00' }, // el de la captura del usuario
  { id: 3665061, MOVED_TIME: '2026-10-21T14:46:35+03:00' },
  { id: 3663515, MOVED_TIME: '2026-10-21T14:55:05+03:00' }, // los tres del minuto 14:55...
  { id: 3663277, MOVED_TIME: '2026-10-21T14:55:23+03:00' },
  { id: 3662677, MOVED_TIME: '2026-10-21T14:55:38+03:00' }, // ...en ventanas de 10 s distintas
  { id: 3669199, MOVED_TIME: '2026-10-21T17:42:37+03:00' },
  { id: 3669789, MOVED_TIME: '2026-10-21T21:08:16+03:00' },
  { id: 3669699, MOVED_TIME: '2026-10-21T21:08:29+03:00' },
  { id: 3670011, MOVED_TIME: '2026-10-21T22:57:58+03:00' },
].map((d) => ({ ...d, MOVED_BY_ID: '685357', STAGE_ID: 'C73:UC_KY8NN7' }));

test('el trabajo real de un asesor (37 casos espaciados en el día) NO se marca como barrido', () => {
  const enBarrido = detectarBarridosEnBloque(JEFFERSON_REAL.map((d) => d.id), mapa(JEFFERSON_REAL));
  assert.equal(enBarrido.size, 0, 'ninguno es barrido: los movió uno por uno, con minutos de diferencia');
  assert.ok(!enBarrido.has(3667905), 'el caso de la captura ya no se descuenta');
});

test('un barrido instantáneo (muchos casos en el mismo segundo) SÍ se marca', () => {
  // El caso del 2026-10-06: 5 casos movidos "de una vez" a Remarketing por la misma persona.
  const barrido = [1, 2, 3, 4, 5].map((id) => ({ id, MOVED_BY_ID: '999', MOVED_TIME: '2026-10-06T03:00:00+03:00', STAGE_ID: 'C73:APOLOGY' }));
  const enBarrido = detectarBarridosEnBloque(barrido.map((d) => d.id), mapa(barrido));
  assert.equal(enBarrido.size, 5, 'todos caen en el mismo bloque de tiempo');
});

test('tres casos dentro de la misma ventana de 10 s cuentan como barrido; repartidos, no', () => {
  const juntos = [
    { id: 10, MOVED_TIME: '2026-10-06T03:00:01+03:00' },
    { id: 11, MOVED_TIME: '2026-10-06T03:00:03+03:00' },
    { id: 12, MOVED_TIME: '2026-10-06T03:00:08+03:00' }, // los 3 en el bloque [03:00:00, 03:00:10)
  ].map((d) => ({ ...d, MOVED_BY_ID: '999', STAGE_ID: 'C73:APOLOGY' }));
  assert.equal(detectarBarridosEnBloque(juntos.map((d) => d.id), mapa(juntos)).size, 3);

  const repartidos = [
    { id: 20, MOVED_TIME: '2026-10-06T03:00:01+03:00' },
    { id: 21, MOVED_TIME: '2026-10-06T03:02:00+03:00' },
    { id: 22, MOVED_TIME: '2026-10-06T03:05:00+03:00' }, // mismos 3, pero con minutos entre medio
  ].map((d) => ({ ...d, MOVED_BY_ID: '999', STAGE_ID: 'C73:APOLOGY' }));
  assert.equal(detectarBarridosEnBloque(repartidos.map((d) => d.id), mapa(repartidos)).size, 0);
});

test('dos casos simultáneos no alcanzan el mínimo; personas o etapas distintas no se agrupan', () => {
  const dos = [
    { id: 30, MOVED_BY_ID: '999', MOVED_TIME: '2026-10-06T03:00:00+03:00', STAGE_ID: 'C73:APOLOGY' },
    { id: 31, MOVED_BY_ID: '999', MOVED_TIME: '2026-10-06T03:00:01+03:00', STAGE_ID: 'C73:APOLOGY' },
  ];
  assert.equal(detectarBarridosEnBloque(dos.map((d) => d.id), mapa(dos)).size, 0);

  const mixto = [
    { id: 40, MOVED_BY_ID: '111', MOVED_TIME: '2026-10-06T03:00:00+03:00', STAGE_ID: 'C73:APOLOGY' },
    { id: 41, MOVED_BY_ID: '222', MOVED_TIME: '2026-10-06T03:00:00+03:00', STAGE_ID: 'C73:APOLOGY' },
    { id: 42, MOVED_BY_ID: '333', MOVED_TIME: '2026-10-06T03:00:00+03:00', STAGE_ID: 'C73:UC_KY8NN7' },
  ];
  assert.equal(detectarBarridosEnBloque(mixto.map((d) => d.id), mapa(mixto)).size, 0, 'distinta persona/etapa: no es un barrido');
});
