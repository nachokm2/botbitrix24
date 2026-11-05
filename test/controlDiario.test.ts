import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Control diario de cierre: al terminar la revisión de la mañana, manda cómo cerró el bot en las
// últimas 24 h, dónde se perdió gente, qué falló y hasta tres cambios con su evidencia. Antes, lo que
// se podía cambiar hoy aparecía en el resumen del lunes siguiente.
process.env.MARCA = 'carver';
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.CONTROL_DIARIO_USUARIOS = '4173,99';

let respuestaModelo = '{"mejoras":[]}';
const pedidos: any[] = [];
mock.module('../src/ai/client.ts', {
  namedExports: {
    anthropic: {
      messages: {
        create: async (p: any) => {
          pedidos.push(p);
          return { content: [{ type: 'text', text: respuestaModelo }], usage: {} };
        },
      },
    },
    REASONER: 'claude-test-sonnet',
    CLASSIFIER: 'claude-test-haiku',
  },
});

const embudoCero = { atendidas: 0, captura: 0, escal: 0, matriculaInicia: 0, enlacePago: 0, interesPerdido: 0 };
let embudoHoy: any = { ...embudoCero };
let embudoSemana: any = { ...embudoCero };
let previas: any[] = [];
mock.module('../src/store/db.ts', {
  namedExports: {
    dbEmbudoCierre: async (_dias: number, offset: number) => (offset === 0 ? embudoHoy : embudoSemana),
    dbMejorasPrevias: async () => previas,
    dbInsertAudit: async () => {},
    // Lo que arrastra revisionDiaria.ts (seguimiento.ts → vigilanciaDerivaciones.ts), que acá se
    // importa para ver qué recibe el auditor en Carver.
    dbTranscripcionesRecientes: async () => [],
    dbUltimaDerivacion: async () => null,
    dbHuboOperadorDespuesDe: async () => false,
    dbDialogosConDeal: async () => [],
    dbDialogosPorTextoPrograma: async () => [],
  },
});

let asesores: any[] = [];
mock.module('../src/crm/vistaAsesores.ts', { namedExports: { vistaPorAsesor: async () => ({ filas: asesores, porMotivo: {}, casos: [] }) } });

const notificaciones: any[] = [];
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: async (method: string, params: any) => {
      if (method === 'im.notify.personal.add') notificaciones.push(params);
      return {};
    },
    callCrm: async () => ({}),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: {} }),
    callWebhook: async () => ({}),
  },
});

const auditorias: any[] = [];
mock.module('../src/obs/audit.ts', { namedExports: { audit: async (e: any) => void auditorias.push(e) } });
mock.module('../src/store.ts', {
  namedExports: {
    getState: async () => ({ auth: { domain: 'carver.bitrix24.com', access_token: 'tok' }, botId: 1 }),
    setAuth: async () => {},
    setBotId: async () => {},
    setAppToken: async () => {},
    requireAuth: async () => ({ domain: 'carver.bitrix24.com', access_token: 'tok' }),
    EMPTY_AUTH: { domain: '', access_token: '' },
  },
});

const { redactarControl, enviarControlDiario, elegirConversaciones, fechaEnChile } = await import('../src/ai/controlDiario');
const { revisarConversacion } = await import('../src/ai/revisionDiaria');
const { referenciaPreciosCarver } = await import('../src/core/condicionesCarver');
const { config } = await import('../src/config');

const DOM = 'carver.bitrix24.com';
const caso = (dialogId: string, turnos: number, hallazgos: any[] = [], crmEntity: string | null = null) => ({
  dialogId,
  crmEntity,
  turnos,
  hallazgos,
  texto: `Cliente: hola (${dialogId})\nBot: le cuento…`,
});
const perdido = { tipo: 'interes_perdido', gravedad: 'alta', detalle: 'Quería Psicología, vio el precio y se fue sin que le pidieran el correo.' };
const repetido = { tipo: 'dato_repetido', gravedad: 'media', detalle: 'Le pidió el país dos veces.' };

const base = {
  fecha: 'martes, 4 de noviembre',
  cur: { atendidas: 20, captura: 5, escal: 3, matriculaInicia: 1, enlacePago: 0, interesPerdido: 2 },
  semana: { atendidas: 140, captura: 21, escal: 14, matriculaInicia: 3, enlacePago: 2, interesPerdido: 14 },
  revisadas: 20,
  unIntercambio: 9,
  porTipo: { interes_perdido: 2, dato_repetido: 1 },
  graves: 2,
  ejemplos: [{ tipo: 'interes_perdido', detalle: perdido.detalle, dialogId: 'chat1572073', crmEntity: 'deal#995431' }],
  mejoras: [
    { mejora: 'Pedir el correo junto con el precio.', evidencia: 'chat1572073', donde: 'bot', repetida: false },
    { mejora: 'Cargar la fecha de inicio de Ergonomía.', evidencia: '', donde: 'panel', repetida: true },
  ],
  sinTrabajar: [
    { nombre: 'Valezka Hernández', pendientes: 2 },
    { nombre: 'Ana Pérez', pendientes: 0 },
  ],
};

test('el mensaje dice cómo cerró, dónde se perdió gente, qué falló y qué cambiar', () => {
  const t = redactarControl(base, DOM);
  assert.match(t, /Control diario — agente .* · martes, 4 de noviembre/);
  // Cada porcentaje con la semana previa al lado: un día suelto no dice si mejora o empeora.
  assert.match(t, /20 conversaciones\. Datos capturados en 5 \(25%; semana previa 15%\), derivadas a un asesor 3 \(15%; semana previa 10%\)/);
  assert.match(t, /Matrícula en el chat: 1 con ficha iniciada y 0 con enlace de pago/);
  assert.match(t, /9 de 20 revisadas quedaron en un solo intercambio; 2 con interés claro se fueron .* \(semana previa: 2 al día\)/);
  assert.match(t, /Qué falló:\[\/B\] interés perdido 2, dato repetido 1 \(2 graves\)/);
  assert.match(t, /• Interés perdido: Quería Psicología.* — \[URL=https:\/\/carver\.bitrix24\.com\/online\/\?IM_DIALOG=chat1572073\]abrir chat\[\/URL\] · \[URL=https:\/\/carver\.bitrix24\.com\/crm\/deal\/details\/995431\/\]negociación #995431\[\/URL\]/);
  assert.match(t, /1\. \[B\]Bot:\[\/B\] Pedir el correo junto con el precio\. \(\[URL=https:\/\/carver\.bitrix24\.com\/online\/\?IM_DIALOG=chat1572073\]chat1572073\[\/URL\]\)/);
  assert.match(t, /2\. \[B\]Panel:\[\/B\] Cargar la fecha de inicio de Ergonomía\. · ya se propuso antes y sigue pendiente/);
  assert.match(t, /2 derivados de los últimos 7 días siguen sin trabajar:\[\/B\] Valezka Hernández \(2\)\./);
  assert.doesNotMatch(t, /Ana Pérez/, 'quien no tiene pendientes no se nombra');
});

test('sin análisis o sin nada que proponer, lo dice en vez de callarlo', () => {
  assert.match(redactarControl({ ...base, mejoras: null }, DOM), /el análisis falló/);
  assert.match(redactarControl({ ...base, mejoras: [] }, DOM), /nada nuevo; el día no mostró una fuga clara/);
  assert.match(redactarControl({ ...base, porTipo: {}, graves: 0, ejemplos: [] }, DOM), /la revisión no encontró problemas/);
});

test('un día sin conversaciones no inventa porcentajes sobre cero', () => {
  const t = redactarControl({ ...base, cur: { ...base.cur, atendidas: 0 }, revisadas: 0 }, DOM);
  assert.match(t, /el bot no atendió conversaciones/);
  assert.doesNotMatch(t, /%/);
});

test('el análisis lee primero los chats donde se perdió a alguien, y después los de un solo intercambio', () => {
  const casos = [
    caso('chat1', 6),
    caso('chat2', 1),
    caso('chat3', 4, [repetido]),
    caso('chat4', 5, [perdido]),
    caso('chat5', 1),
    caso('chat6', 1),
  ];
  assert.deepEqual(elegirConversaciones(casos).map((c) => c.dialogId), ['chat4', 'chat3', 'chat2', 'chat5']);
  const muchos = Array.from({ length: 10 }, (_, i) => caso(`chat${i}`, 3, [perdido]));
  assert.equal(elegirConversaciones(muchos).length, 4, 'hasta 4 de la misma clase');
});

test('se envía a cada destinatario, con las mejoras del modelo y la memoria de los días anteriores', async () => {
  pedidos.length = 0;
  notificaciones.length = 0;
  auditorias.length = 0;
  embudoHoy = base.cur;
  embudoSemana = base.semana;
  previas = [{ ts: '2026-11-03T12:05:00Z', mejoras: [{ mejora: 'Cargar la fecha de inicio de Ergonomía.' }] }];
  asesores = [{ nombre: 'Valezka Hernández', pendientes: 1 }];
  respuestaModelo = JSON.stringify({
    mejoras: [
      { mejora: 'Pedir el correo junto con el precio.', evidencia: 'chat4', donde: 'bot', repetida: false },
      { mejora: 'Cargar la fecha de inicio de Ergonomía.', evidencia: 'chat3', donde: 'panel', repetida: true },
      { mejora: 'Llamar a los derivados el mismo día.', evidencia: '1 sin trabajar', donde: 'inventado', repetida: false },
      { mejora: 'Una cuarta que sobra.', evidencia: '', donde: 'bot' },
    ],
  });
  const revision = {
    revisadas: 3,
    conProblemas: 1,
    porTipo: { interes_perdido: 1 },
    graves: 1,
    casos: [caso('chat1', 6), caso('chat2', 1), caso('chat4', 5, [perdido], 'deal#995431')],
  };

  const texto = await enviarControlDiario(revision);
  assert.ok(texto);
  assert.deepEqual(notificaciones.map((n) => n.USER_ID), [4173, 99]);

  const material = pedidos[0].messages[0].content as string;
  assert.equal(pedidos[0].model, 'claude-test-sonnet', 'proponer cambios es criterio: va al modelo grande');
  assert.match(material, /\[interes_perdido, alta\] chat4: Quería Psicología/);
  assert.match(material, /\(2026-11-03\) Cargar la fecha de inicio de Ergonomía\./, 'recibe lo que se propuso antes');
  assert.match(material, /De 3 conversaciones revisadas, 1 quedaron en un solo intercambio/);
  assert.match(material, /ningún asesor trabajó: 1/);
  assert.ok(material.indexOf('=== chat4 ===') < material.indexOf('=== chat2 ==='), 'primero el chat donde se perdió a alguien');
  assert.match(material, /contado: USD 585 al año durante 4 años/, 'tiene la planilla para no proponer corregir un precio correcto');
  assert.match(material, /la revisión se equivocó: no propongas corregirlo/);
  assert.doesNotMatch(material, /=== chat1 ===/, 'una conversación normal no se manda a analizar');

  assert.match(texto!, /3\. \[B\]Bot:\[\/B\] Llamar a los derivados/, 'un "donde" desconocido cae en Bot');
  assert.doesNotMatch(texto!, /cuarta/, 'como máximo 3 mejoras');
  assert.match(texto!, /negociación #995431/);
  const a = auditorias.find((x) => x.type === 'control_diario');
  assert.equal(a.detail.mejoras.length, 3, 'las mejoras quedan para el análisis de mañana');
  assert.equal(a.detail.fallo, false);
});

test('si el modelo devuelve basura, el control sale igual y avisa que el análisis falló', async () => {
  notificaciones.length = 0;
  auditorias.length = 0;
  embudoHoy = base.cur;
  respuestaModelo = 'lo siento, no puedo';
  const texto = await enviarControlDiario({ revisadas: 1, conProblemas: 0, porTipo: {}, graves: 0, casos: [caso('chat1', 3)] });
  assert.match(texto!, /el análisis falló/);
  assert.equal(notificaciones.length, 2);
  assert.equal(auditorias.find((x) => x.type === 'control_diario').detail.fallo, true);
});

test('sin conversaciones no llama al modelo', async () => {
  pedidos.length = 0;
  embudoHoy = { ...embudoCero };
  const texto = await enviarControlDiario({ revisadas: 0, conProblemas: 0, porTipo: {}, graves: 0, casos: [] });
  assert.match(texto!, /no atendió conversaciones/);
  assert.equal(pedidos.length, 0);
});

test('sin destinatarios no hace nada', async () => {
  pedidos.length = 0;
  notificaciones.length = 0;
  const antes = config.controlDiarioDestinatarios;
  (config as any).controlDiarioDestinatarios = [];
  try {
    assert.equal(await enviarControlDiario({ revisadas: 1, conProblemas: 0, porTipo: {}, graves: 0, casos: [caso('chat1', 3)] }), null);
  } finally {
    (config as any).controlDiarioDestinatarios = antes;
  }
  assert.equal(pedidos.length, 0);
  assert.equal(notificaciones.length, 0);
});

// 05-11-2026: la revisión marcó como dudosos el contado de Psicología (USD 585 al año durante 4 años)
// y el de una maestría (USD 900) porque eran menores que el arancel con beca, y el control propuso
// "corregirlos" en el panel. Estaban bien: la planilla los fija así.
test('la planilla de precios trae las cifras vigentes y explica por qué el contado es menor', () => {
  const t = referenciaPreciosCarver();
  assert.match(t, /semestral y el contado son precios fijos, sin matrícula y con un descuento adicional/);
  assert.match(
    t,
    /- Licenciatura en Psicología: lista USD 8\.000; con la beca del 50%, USD 4\.000 en 40 cuotas de USD 100 más matrícula de USD 50; semestral: 8 pagos de USD 410; contado: USD 585 al año durante 4 años \(USD 2\.340 en total\)\./,
  );
  assert.match(t, /- Maestría en Educación en Salud y Simulación Clínica: lista USD 3\.600;.*contado: USD 900\./);
  assert.match(t, /- Licenciatura en Administración de Empresas: .* Cupos completos: la matrícula reabre en marzo de 2027\./);
  assert.doesNotMatch(t, /Curso de/, 'los cursos no se cotizan');
});

test('en Carver el auditor revisa cada conversación con la planilla a la vista', async () => {
  pedidos.length = 0;
  respuestaModelo = '{"problemas":[]}';
  await revisarConversacion('Cliente: cuánto sale psicología al contado\nBot: USD 585 al año durante 4 años, sin matrícula.');
  const system = pedidos[0].system as string;
  assert.match(system, /^Eres un auditor de calidad/, 'las reglas del auditor no cambian');
  assert.match(system, /Licenciatura en Psicología: .*contado: USD 585 al año durante 4 años/);
});

test('la fecha va en la hora de Chile, no la del servidor', () => {
  // 02:00 UTC del miércoles 4 de noviembre son todavía las 23:00 del martes 3 en Chile (UTC-3).
  assert.match(fechaEnChile(new Date('2026-11-04T02:00:00Z')), /martes.*3 de noviembre/);
});
