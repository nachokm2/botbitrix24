import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// bitrixMarchaBlancaScorecard: para cada deal escalado a un asesor (round-robin, ver
// crm/asignacionAsesores.ts), trae su etapa ACTUAL en Bitrix + si ya matriculó — para que el panel
// pueda mostrar "Deals escalados a asesor" (pedido del usuario: verificar matrículas de los 2
// programas piloto viendo dónde quedó cada deal, no solo un conteo agregado).
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = ''; // resolverDialogosPorProgramaPiloto importa asignacionAsesores.ts -> store/kv.ts
process.env.BITRIX_UF_PROGRAMA = 'UF_CRM_PROGRAMA_TEST';

type Call = { method: string; params: any };
const calls: Call[] = [];
let dealsPorContacto: Record<number, number[]> = {}; // contactId -> sus deals
let dealesPorId: Record<
  number,
  { TITLE?: string; STAGE_ID?: string; ASSIGNED_BY_ID?: string; OPPORTUNITY?: string; MOVED_BY_ID?: string; MOVED_TIME?: string }
> = {};

mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: async (method: string, params: any) => record(method, params),
    callCrm: async (method: string, params: any) => record(method, params),
    callBitrixEnvelope: async (method: string, params: any) => ({ result: record(method, params), total: 0 }),
    // countDeals (dealsALaFecha/dealsAntiguos) usa esto con start:-1 — en producción da total:0
    // SIEMPRE (bug real de Bitrix, ver comentario en marchaBlanca.ts), así que el mock replica ese
    // mismo comportamiento conocido en vez de simular un conteo que en la práctica no existe.
    callCrmEnvelope: async () => ({ result: [], total: 0, next: null }),
    callWebhook: async () => ({}),
  },
});
function record(method: string, params: any): any {
  calls.push({ method, params });
  if (method === 'crm.deal.get') return dealesPorId[params.id] ?? {};
  if (method === 'crm.deal.list') {
    if (params.filter?.['@CONTACT_ID']) {
      const contactos: number[] = params.filter['@CONTACT_ID'];
      return contactos.flatMap((c) =>
        (dealsPorContacto[c] ?? []).map((id) => ({ ID: String(id), ...(dealesPorId[id] ?? {}) })),
      );
    }
    const ids: number[] = params.filter?.['@ID'] ?? [];
    return ids.map((id) => ({ ID: String(id), ...(dealesPorId[id] ?? {}) }));
  }
  if (method === 'crm.status.list') {
    return [
      { STATUS_ID: 'C1:NEW', NAME: 'Asignación' },
      { STATUS_ID: 'C1:UC_JARL1O', NAME: 'Contactado' },
      { STATUS_ID: 'C1:WON', NAME: 'Matrícula' },
    ];
  }
  return {};
}

// dbDialogosConDeal/dbDialogosPorTextoPrograma: las 2 señales que resolverDialogosPorProgramaPiloto
// combina — se mockean para controlar el escenario exacto de cada test (los datos reales de
// Postgres se probaron aparte, directo contra la base, ver historial de la sesión).
let dialogosConDeal: Array<{ dialogId: string; dealId: number }> = [];
let dialogosPorTexto: Record<string, string[]> = {}; // match del programa -> dialogIds
mock.module('../src/store/db.ts', {
  namedExports: {
    dbDialogosConDeal: async () => dialogosConDeal,
    dbDialogosPorTextoPrograma: async (prog: { match: string }) => dialogosPorTexto[prog.match] ?? [],
  },
});

const { bitrixMarchaBlancaScorecard, resolverDialogosPorProgramaPiloto } = await import('../src/crm/marchaBlanca');
const { config } = await import('../src/config');
const auth = { domain: 'test.bitrix24.com', access_token: 'tok' } as any;

test('bitrixMarchaBlancaScorecard: "matriculados" y "ticket promedio" salen de negociacionesDetalle (deals que el bot trabajó), NO de un scan amplio de Bitrix (bug real: ese scan da total:0 siempre o tarda 15+ segundos)', async () => {
  calls.length = 0;
  dealesPorId = {
    501: { TITLE: 'Deal A', STAGE_ID: 'C1:WON', OPPORTUNITY: '800000' },
    502: { TITLE: 'Deal B', STAGE_ID: 'C1:WON', OPPORTUNITY: '900000' },
    503: { TITLE: 'Deal C', STAGE_ID: 'C1:UC_JARL1O' }, // en curso, no matriculado — no debe contar
  };
  const botStats = new Map([['ia', { escalados: [], dealsConversados: [501, 502, 503] }]]);

  const out = await bitrixMarchaBlancaScorecard(botStats, auth);
  const ia = out.find((p) => p.key === 'ia')!;

  assert.equal(ia.matriculados, 2, 'cuenta los 2 deals con STAGE_ID :WON entre los que el bot trabajó');
  assert.equal(ia.ticketPromedio, 850000, 'promedio de los 2 montos reales (OPPORTUNITY)');
  assert.equal(ia.dealsALaFecha, 3, 'las 3 negociaciones que el bot trabajó');
  assert.equal(ia.pctCierre, 67, '2 de 3 — antes dividía por un total que Bitrix devolvía como 0 y daba 0%');
});

test('bitrixMarchaBlancaScorecard: sin matrículas, el ticket promedio queda VACÍO (antes mostraba el precio de lista como si fuera ingreso)', async () => {
  calls.length = 0;
  dealesPorId = { 601: { TITLE: 'Deal sin matricular', STAGE_ID: 'C1:UC_JARL1O', OPPORTUNITY: '900000' } };
  const botStats = new Map([['ia', { escalados: [], dealsConversados: [601] }]]);

  const out = await bitrixMarchaBlancaScorecard(botStats, auth);
  const ia = out.find((p) => p.key === 'ia')!;

  assert.equal(ia.matriculados, 0);
  assert.equal(ia.ticketPromedio, null, 'sin matrículas no hay ticket que promediar');
  assert.equal(ia.pctCierre, 0);
});

test('bitrixMarchaBlancaScorecard: arma el detalle por deal escalado (etapa, asesor, motivo, matrícula)', async () => {
  calls.length = 0;
  dealesPorId = {
    401: { TITLE: 'Deal Juan Pérez', STAGE_ID: 'C1:WON', ASSIGNED_BY_ID: '283901' }, // Zaida (Norte IA)
    402: { TITLE: 'Deal María López', STAGE_ID: 'C1:UC_JARL1O', ASSIGNED_BY_ID: '368819' }, // Constanza (Sur IA)
  };
  const botStats = new Map([
    ['ia', {
      escalados: [
        { dealId: 401, motivo: 'explicito' as const },
        { dealId: 402, motivo: 'silencio' as const },
      ],
      dealsConversados: [401, 402],
    }],
  ]);

  const out = await bitrixMarchaBlancaScorecard(botStats, auth);
  const ia = out.find((p) => p.key === 'ia')!;

  assert.equal(ia.escaladosConDeal, 2);
  assert.equal(ia.escaladosMatriculados, 1, 'solo el deal 401 (WON) matriculó');

  const d401 = ia.escaladosDetalle.find((d) => d.dealId === 401)!;
  assert.equal(d401.titulo, 'Deal Juan Pérez');
  assert.equal(d401.asesor, 'Zaida Verdugo', 'resuelve el nombre por ASSIGNED_BY_ID conocido, no deja el ID crudo');
  assert.equal(d401.motivo, 'explicito');
  assert.equal(d401.stageNombre, 'Matrícula', 'usa el nombre real de la etapa (crm.status.list), no el STATUS_ID crudo');
  assert.equal(d401.matriculado, true);

  const d402 = ia.escaladosDetalle.find((d) => d.dealId === 402)!;
  assert.equal(d402.asesor, 'Constanza Huitraiqueo Garabito');
  assert.equal(d402.motivo, 'silencio');
  assert.equal(d402.stageNombre, 'Contactado');
  assert.equal(d402.matriculado, false);

  // negociacionesDetalle debe traer los mismos 2 (están en ambos: escalados Y conversados), marcados
  // como escalado=true — sin duplicar la llamada a crm.deal.get para cada uno.
  assert.equal(ia.negociacionesDetalle.length, 2);
  assert.ok(ia.negociacionesDetalle.every((n) => n.escalado === true));
  // Los deals se traen por LOTES, no uno por uno: con ~60 deals, una llamada por deal dejaba la carga
  // fría del panel en 33 s. Se comprueba que no haya vuelto el crm.deal.get por deal.
  assert.ok(!calls.some((c) => c.method === 'crm.deal.get'), 'no se consulta deal por deal');
  const lotes = calls.filter((c) => c.method === 'crm.deal.list' && c.params.filter?.['@ID']);
  assert.equal(lotes.length, 1, 'los 2 deals se traen en UN solo lote');
});

test('bitrixMarchaBlancaScorecard: caso Katherine — deal conversado pero NUNCA escalado (asignación manual) igual aparece en negociacionesDetalle, con escalado=false', async () => {
  calls.length = 0;
  dealesPorId = { 403: { TITLE: 'Deal Katherine', STAGE_ID: 'C1:UC_JARL1O', ASSIGNED_BY_ID: '9' } };
  const botStats = new Map([['terapia_familiar', { escalados: [], dealsConversados: [403] }]]);

  const out = await bitrixMarchaBlancaScorecard(botStats, auth);
  const tf = out.find((p) => p.key === 'terapia_familiar')!;

  assert.equal(tf.escaladosConDeal, 0, 'no cuenta como "escalado" (nunca pasó por escalar_a_humano)');
  assert.equal(tf.escaladosDetalle.length, 0, 'no aparece en la tabla de escalados');
  assert.equal(tf.negociacionesDetalle.length, 1, 'pero SÍ aparece en la de negociaciones trabajadas');
  const n = tf.negociacionesDetalle[0];
  assert.equal(n.dealId, 403);
  assert.equal(n.escalado, false);
  assert.equal(n.motivo, null);
  assert.equal(n.asesor, 'Joaquín Retamal');
});

test('bitrixMarchaBlancaScorecard: sin escalados ni conversados, ambos detalles quedan vacíos (no llama crm.deal.get de más)', async () => {
  calls.length = 0;
  dealesPorId = {};
  const botStats = new Map([['ia', { escalados: [], dealsConversados: [] }]]);

  const out = await bitrixMarchaBlancaScorecard(botStats, auth);
  const ia = out.find((p) => p.key === 'ia')!;

  assert.deepEqual(ia.escaladosDetalle, []);
  assert.deepEqual(ia.negociacionesDetalle, []);
  assert.ok(!calls.find((c) => c.method === 'crm.deal.get'));
});

test('resolverDialogosPorProgramaPiloto: combina el diálogo por TEXTO con el diálogo detectado por el programa REAL del Deal (caso real: 93/106 diálogos no tenían registrar_interes_crm con texto de programa)', async () => {
  calls.length = 0;
  dealesPorId = {};
  // dlg-texto: solo se sabe por el texto que el bot pasó a registrar_interes_crm (nunca llegó a Deal).
  dialogosPorTexto = { 'Terapéutica Familiar': ['dlg-texto'] };
  // dlg-deal-viejo: el bot conversó con un Deal que YA traía el programa cargado desde antes (por
  // campaña) — el bot correctamente no volvió a registrar el texto, así que NO aparece en
  // dialogosPorTexto, solo se puede saber consultando el Deal real.
  dialogosConDeal = [{ dialogId: 'dlg-deal-viejo', dealId: 900 }];
  dealesPorId[900] = { UF_CRM_PROGRAMA_TEST: 'Diplomado en Intervención Terapéutica Familiar' } as any;

  const mapa = await resolverDialogosPorProgramaPiloto(auth);

  assert.deepEqual(new Set(mapa.get('terapia_familiar')), new Set(['dlg-texto', 'dlg-deal-viejo']), 'une ambas señales, no solo la de texto');
  assert.deepEqual(mapa.get('ia'), [], 'no contamina el otro programa');
});

test('resolverDialogosPorProgramaPiloto: un Deal de un programa NO piloto no se cuela', async () => {
  calls.length = 0;
  dealesPorId = { 901: { UF_CRM_PROGRAMA_TEST: 'Diplomado en Otra Cosa' } as any };
  dialogosPorTexto = {};
  dialogosConDeal = [{ dialogId: 'dlg-otro', dealId: 901 }];

  const mapa = await resolverDialogosPorProgramaPiloto(auth);

  assert.deepEqual(mapa.get('terapia_familiar'), []);
  assert.deepEqual(mapa.get('ia'), []);
});

test('resolverDialogosPorProgramaPiloto: pide los deals de a 50 — crm.deal.list no devuelve más por página', async () => {
  // Bug real: se pedían los 74 deals del histórico en UNA llamada; Bitrix devolvía 50 y los otros 24
  // quedaban sin programa, así que el panel mostraba 21 negociaciones en Terapéutica Familiar cuando
  // eran 29, y 11 en Inteligencia Artificial cuando eran 18.
  calls.length = 0;
  dealesPorId = {};
  dialogosPorTexto = {};
  dialogosConDeal = [];
  for (let i = 1; i <= 120; i++) {
    const dealId = 1000 + i;
    dialogosConDeal.push({ dialogId: 'dlg-' + i, dealId });
    dealesPorId[dealId] = { UF_CRM_PROGRAMA_TEST: 'Diplomado en Intervención Terapéutica Familiar' } as any;
  }

  const mapa = await resolverDialogosPorProgramaPiloto(auth);

  const lotes = calls.filter((c) => c.method === 'crm.deal.list');
  assert.equal(lotes.length, 3, '120 deals → 3 llamadas de 50, 50 y 20');
  assert.ok(lotes.every((l) => (l.params.filter['@ID'] ?? []).length <= 50), 'ningún lote puede exceder 50');
  assert.equal(mapa.get('terapia_familiar')!.length, 120, 'no se puede perder ningún diálogo por el corte de página');
});

test('bitrixMarchaBlancaScorecard: cuenta los "postulantes" por la etapa configurada, no por su nombre', async () => {
  // Es la MISMA etapa a la que el bot promueve por score alto con datos completos (BITRIX_STAGE_MAP).
  // Buscarla por el nombre "Postulantes" sería frágil: en Bitrix se puede renombrar una etapa.
  calls.length = 0;
  const original = JSON.stringify(config.stageMap);
  (config as any).stageMap = { '1': { alto: 'C1:UC_7IPG9H', medio: 'C1:UC_H45JCL' } };
  dealesPorId = {
    801: { TITLE: 'Va postulando', STAGE_ID: 'C1:UC_7IPG9H' },
    802: { TITLE: 'Otro postulante', STAGE_ID: 'C1:UC_7IPG9H' },
    803: { TITLE: 'Solo interesado', STAGE_ID: 'C1:UC_H45JCL' },
    804: { TITLE: 'Ya matriculado', STAGE_ID: 'C1:WON', OPPORTUNITY: '800000' },
  };
  try {
    const out = await bitrixMarchaBlancaScorecard(
      new Map([['terapia_familiar', { escalados: [], dealsConversados: [801, 802, 803, 804] }]]),
      auth,
    );
    const tf = out.find((p) => p.key === 'terapia_familiar')!;
    assert.equal(tf.postulantes, 2, 'solo los 2 que están en la etapa de postulación');
    assert.equal(tf.matriculados, 1, 'el matriculado ya NO cuenta como postulante');
  } finally {
    (config as any).stageMap = JSON.parse(original);
  }
});

test('bitrixMarchaBlancaScorecard: suma las conversaciones vinculadas a un CONTACTO, no solo las de negociación', async () => {
  // La mitad de las conversaciones del bot quedan vinculadas al contacto (75 y 75 en producción):
  // contando solo las de negociación, la tabla mostraba la mitad del trabajo real, y un cliente que
  // sí conversó aparecía como nunca atendido (caso real: Fernando Calderón, deal #3530073).
  calls.length = 0;
  dealesPorId = {
    901: { TITLE: 'Vino por deal', STAGE_ID: 'C1:UC_JARL1O', UF_CRM_PROGRAMA_TEST: 'Diplomado en Intervención Terapéutica Familiar' } as any,
    902: { TITLE: 'Vino por contacto', STAGE_ID: 'C1:UC_JARL1O', UF_CRM_PROGRAMA_TEST: 'Diplomado en Intervención Terapéutica Familiar' } as any,
    903: { TITLE: 'De otro programa', STAGE_ID: 'C1:UC_JARL1O', UF_CRM_PROGRAMA_TEST: 'Diplomado en Otra Cosa' } as any,
  };
  dealsPorContacto = { 555: [902, 903] }; // el contacto tiene 2 deals, solo uno es de este programa

  const out = await bitrixMarchaBlancaScorecard(
    new Map([['terapia_familiar', { escalados: [], dealsConversados: [901], contactosConversados: [555] }]]),
    auth,
  );
  const tf = out.find((p) => p.key === 'terapia_familiar')!;

  assert.equal(tf.dealsALaFecha, 2, 'el deal directo + el que se resolvió desde el contacto');
  const ids = tf.negociacionesDetalle.map((n) => n.dealId).sort();
  assert.deepEqual(ids, [901, 902]);
  assert.ok(!ids.includes(903), 'no se cuela el deal del contacto que es de otro programa');
});

// La columna de seguimiento reemplazó a un "SLA contacto asesor" que era estructuralmente imposible:
// medía el tiempo hasta el primer mensaje de un operador DENTRO del chat del bot, pero al transferir
// la sesión el bot deja de recibir esos mensajes y los asesores trabajan por teléfono/correo desde
// Bitrix. Resultado real: 10 escalamientos, 0 casos medidos, columna siempre en "—".
//
// Lo que sí se puede medir contra el CRM es quién movió la negociación después de derivarla. El
// riesgo de esa señal es contar como "el asesor tomó el caso" el barrido automático que pasa a RMKT
// las negociaciones que nadie tocó: en producción ese robot (#45 "Resp. Autom.") movió 31 de las 36
// derivaciones del piloto, así que sin descartarlo la columna diría que casi todo se atendió.
test('bitrixMarchaBlancaScorecard: el seguimiento cuenta al asesor que movió la negociación y descarta el barrido automático (#45)', async () => {
  calls.length = 0;
  const T0 = Date.parse('2026-09-10T12:00:00.000Z');
  const mas = (h: number) => new Date(T0 + h * 3600_000).toISOString();
  dealesPorId = {
    701: { TITLE: 'Tomado a las 3 h', STAGE_ID: 'C1:UC_JARL1O', MOVED_BY_ID: '346393', MOVED_TIME: mas(3) },
    704: { TITLE: 'Tomado a las 5 h', STAGE_ID: 'C1:UC_JARL1O', MOVED_BY_ID: '368819', MOVED_TIME: mas(5) },
    705: { TITLE: 'Tomado a las 30 h', STAGE_ID: 'C1:WON', MOVED_BY_ID: '9', MOVED_TIME: mas(30) },
    702: { TITLE: 'Barrido a RMKT', STAGE_ID: 'C1:APOLOGY', MOVED_BY_ID: '45', MOVED_TIME: mas(20) },
    703: { TITLE: 'Último movimiento previo a derivar', STAGE_ID: 'C1:NEW', MOVED_BY_ID: '346393', MOVED_TIME: mas(-4) },
  };
  const ts = new Date(T0).toISOString();
  const botStats = new Map([
    ['ia', {
      escalados: [
        { dealId: 701, motivo: 'explicito' as const, ts },
        { dealId: 704, motivo: 'silencio' as const, ts },
        { dealId: 705, motivo: 'explicito' as const, ts },
        { dealId: 702, motivo: 'silencio' as const, ts },
        { dealId: 703, motivo: 'explicito' as const, ts },
      ],
      dealsConversados: [],
    }],
  ]);

  const out = await bitrixMarchaBlancaScorecard(botStats, auth);
  const ia = out.find((p) => p.key === 'ia')!;

  assert.equal(ia.seguimiento.derivados, 5, 'el denominador son TODAS las derivaciones, explícitas y por silencio');
  assert.equal(
    ia.seguimiento.atendidos,
    3,
    'quedan fuera el barrido automático (#45) y el deal cuyo último movimiento es anterior a la derivación',
  );
  assert.equal(ia.seguimiento.medianaSeg, 5 * 3600, 'mediana de 3 h / 5 h / 30 h — no el promedio, que los 30 h desvirtuarían');

  // No debe costar llamadas extra a Bitrix: los dos campos viajan en el crm.deal.list que ya se hacía.
  assert.equal(calls.filter((c) => c.method === 'crm.activity.list').length, 0, 'no consulta actividades');
  const select = calls.find((c) => c.method === 'crm.deal.list' && c.params.filter?.['@ID'])?.params.select ?? [];
  assert.ok(select.includes('MOVED_BY_ID') && select.includes('MOVED_TIME'), 'viajan en la consulta de deals que ya existía');
});

test('bitrixMarchaBlancaScorecard: sin derivaciones, el seguimiento queda vacío en vez de mostrar un 0/0 engañoso', async () => {
  calls.length = 0;
  dealesPorId = { 801: { TITLE: 'Solo conversado', STAGE_ID: 'C1:UC_JARL1O', MOVED_BY_ID: '346393', MOVED_TIME: '2026-09-11T12:00:00.000Z' } };
  const botStats = new Map([['ia', { escalados: [], dealsConversados: [801] }]]);

  const out = await bitrixMarchaBlancaScorecard(botStats, auth);
  const ia = out.find((p) => p.key === 'ia')!;

  assert.equal(ia.seguimiento.derivados, 0);
  assert.equal(ia.seguimiento.atendidos, 0);
  assert.equal(ia.seguimiento.medianaSeg, null, 'sin casos no hay mediana que mostrar');
});
