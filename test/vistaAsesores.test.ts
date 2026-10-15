import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Vista por asesor del panel: de lo que el bot derivó a cada persona, cuánto trabajó. El scorecard
// de marcha blanca responde "cómo va cada programa"; esto responde "cómo va cada asesor", que es lo
// que el agregado deja afuera — "4 de 38 trabajadas" no dice a quién hay que ayudar.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

let derivaciones: Array<{ dealId: number; ts: string; dialogId: string | null; motivo: string }> = [];
mock.module('../src/store/db.ts', {
  namedExports: {
    dbUltimaDerivacion: async () => null,
    dbDerivaciones: async () => derivaciones,
    dbInsertAudit: async () => {},
    // marchaBlanca.ts (de donde sale detectarBarridosEnBloque) importa estas dos: el mock debe
    // exportar todo lo que el grafo de imports consume, o el módulo real ni siquiera carga.
    dbDialogosConDeal: async () => [],
    dbDialogosPorTextoPrograma: async () => [],
  },
});

let deals: Record<string, any>[] = [];
const lotes: number[][] = [];
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callCrm: async (method: string, params: any) => {
      if (method !== 'crm.deal.list') return {};
      const ids: number[] = params.filter['@ID'];
      lotes.push(ids);
      // Bitrix devuelve como máximo 50 filas por página: el fake respeta ese tope para que un lote
      // mal armado se note acá y no en producción.
      return deals.filter((d) => ids.includes(Number(d.ID))).slice(0, 50);
    },
    callBitrix: async () => ({}),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: {} }),
    callWebhook: async () => ({}),
  },
});

mock.module('../src/crm/directory.ts', {
  namedExports: {
    getUsuarios: async (ids: number[]) => ids.map((id) => ({ id, nombre: `Asesor real ${id}` })),
  },
});

const { vistaPorAsesor } = await import('../src/crm/vistaAsesores');
const { config } = await import('../src/config');

const auth = { domain: 'test.bitrix24.com', access_token: 'tok' } as any;
const hace = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

function escenario(filas: Array<{ dealId: number; derivadoHace: number; asignado: number; movidoPor?: number; movidoHace?: number; stage?: string }>) {
  derivaciones = filas.map((f) => ({ dealId: f.dealId, ts: hace(f.derivadoHace), dialogId: `chat${f.dealId}`, motivo: 'pedido' }));
  deals = filas.map((f) => ({
    ID: String(f.dealId),
    ASSIGNED_BY_ID: String(f.asignado),
    MOVED_BY_ID: f.movidoPor ? String(f.movidoPor) : '',
    MOVED_TIME: f.movidoHace != null ? hace(f.movidoHace) : null,
    STAGE_ID: f.stage ?? 'C1:NEW',
  }));
  lotes.length = 0;
}

test('cuenta derivados, tomados y pendientes por asesor', async () => {
  escenario([
    { dealId: 1, derivadoHace: 10, asignado: 100, movidoPor: 100, movidoHace: 8 }, // tomado a las 2 h
    { dealId: 2, derivadoHace: 10, asignado: 100 }, // nunca tocado
    { dealId: 3, derivadoHace: 10, asignado: 200, movidoPor: 200, movidoHace: 4 }, // tomado a las 6 h
  ]);
  const { filas } = await vistaPorAsesor(auth);

  const a100 = filas.find((f) => f.id === 100)!;
  assert.equal(a100.derivados, 2);
  assert.equal(a100.atendidos, 1);
  assert.equal(a100.pendientes, 1);
  assert.equal(a100.medianaSeg, 2 * 3600);
  assert.equal(a100.nombre, 'Asesor real 100');

  const a200 = filas.find((f) => f.id === 200)!;
  assert.equal(a200.pendientes, 0);
  assert.equal(a200.medianaSeg, 6 * 3600);
});

test('ordena primero a quien tiene más casos sin trabajar', async () => {
  escenario([
    { dealId: 1, derivadoHace: 5, asignado: 100, movidoPor: 100, movidoHace: 4 },
    { dealId: 2, derivadoHace: 5, asignado: 200 },
    { dealId: 3, derivadoHace: 5, asignado: 200 },
  ]);
  const { filas } = await vistaPorAsesor(auth);
  assert.equal(filas[0].id, 200, 'la fila accionable va arriba');
});

test('el robot que barre a Remarketing no cuenta como que el asesor lo tomó', async () => {
  const robot = config.usuariosAutomaticos[0];
  escenario([{ dealId: 1, derivadoHace: 10, asignado: 100, movidoPor: robot, movidoHace: 2 }]);
  const { filas } = await vistaPorAsesor(auth);
  assert.equal(filas[0].atendidos, 0);
  assert.equal(filas[0].pendientes, 1);
});

test('un movimiento en bloque tampoco cuenta como atención', async () => {
  // Tres casos movidos por la misma persona, el mismo día, a la misma etapa: es un barrido manual,
  // no tres decisiones. Pasó de verdad el 2026-10-06 con 24 negociaciones a la vez.
  escenario([
    { dealId: 1, derivadoHace: 100, asignado: 100, movidoPor: 777, movidoHace: 1, stage: 'C1:RMKT' },
    { dealId: 2, derivadoHace: 100, asignado: 100, movidoPor: 777, movidoHace: 1, stage: 'C1:RMKT' },
    { dealId: 3, derivadoHace: 100, asignado: 100, movidoPor: 777, movidoHace: 1, stage: 'C1:RMKT' },
  ]);
  const { filas } = await vistaPorAsesor(auth);
  assert.equal(filas[0].atendidos, 0);
  assert.equal(filas[0].pendientes, 3);
});

test('dos casos movidos el mismo día SÍ cuentan: no alcanza para ser un barrido', async () => {
  escenario([
    { dealId: 1, derivadoHace: 10, asignado: 100, movidoPor: 100, movidoHace: 1, stage: 'C1:WON' },
    { dealId: 2, derivadoHace: 10, asignado: 100, movidoPor: 100, movidoHace: 1, stage: 'C1:WON' },
  ]);
  const { filas } = await vistaPorAsesor(auth);
  assert.equal(filas[0].atendidos, 2);
});

test('un movimiento anterior a la derivación no cuenta como respuesta a ella', async () => {
  escenario([{ dealId: 1, derivadoHace: 2, asignado: 100, movidoPor: 100, movidoHace: 20 }]);
  const { filas } = await vistaPorAsesor(auth);
  assert.equal(filas[0].atendidos, 0);
});

test('pide las negociaciones de a 50: una sola página perdía el resto', async () => {
  const filas = Array.from({ length: 120 }, (_, i) => ({ dealId: i + 1, derivadoHace: 5, asignado: 100 }));
  escenario(filas);
  const { filas: r } = await vistaPorAsesor(auth);
  assert.equal(lotes.length, 3, '120 derivaciones = 3 páginas');
  assert.ok(lotes.every((l) => l.length <= 50));
  assert.equal(r[0].derivados, 120, 'ninguna se pierde');
});

test('sin derivaciones no inventa filas', async () => {
  escenario([]);
  assert.deepEqual((await vistaPorAsesor(auth)).filas, []);
});

test('informa por qué llegó cada caso: es lo que explica el total', async () => {
  // El total de esta tabla no coincide con la tarjeta "Escalamientos a asesor" porque ahí no entran
  // las derivaciones por silencio. Sin el desglose, parecen dos números en conflicto.
  escenario([
    { dealId: 1, derivadoHace: 5, asignado: 100 },
    { dealId: 2, derivadoHace: 5, asignado: 100 },
    { dealId: 3, derivadoHace: 5, asignado: 200 },
  ]);
  derivaciones[0].motivo = 'pedido';
  derivaciones[1].motivo = 'silencio';
  derivaciones[2].motivo = 'silencio';
  const { porMotivo } = await vistaPorAsesor(auth);
  assert.deepEqual(porMotivo, { pedido: 1, silencio: 2 });
});

test('devuelve el detalle de cada caso, con lo necesario para ir a verlo', async () => {
  escenario([
    { dealId: 1, derivadoHace: 10, asignado: 100, movidoPor: 100, movidoHace: 8 },
    { dealId: 2, derivadoHace: 10, asignado: 100 },
  ]);
  deals[0].TITLE = 'Maestría en Psicología – Ana';
  deals[0].CATEGORY_ID = '73';
  const { casos } = await vistaPorAsesor(auth);

  assert.equal(casos.length, 2);
  // Primero lo que nadie tomó: es la pantalla accionable.
  assert.equal(casos[0].atendido, false);
  assert.equal(casos[0].dealId, 2);
  const tomado = casos.find((c: any) => c.dealId === 1)!;
  assert.equal(tomado.atendido, true);
  assert.equal(tomado.esperaSeg, 2 * 3600);
  assert.equal(tomado.titulo, 'Maestría en Psicología – Ana');
  assert.equal(tomado.asesor, 'Asesor real 100', 'con nombre, no con id');
  assert.equal(tomado.categoria, 73);
});

test('el caso conserva por qué se derivó', async () => {
  escenario([{ dealId: 1, derivadoHace: 5, asignado: 100 }]);
  derivaciones[0].motivo = 'silencio';
  const { casos } = await vistaPorAsesor(auth);
  assert.equal(casos[0].motivo, 'silencio');
});
