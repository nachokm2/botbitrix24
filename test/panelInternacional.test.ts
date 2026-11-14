import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Sección «Conversaciones India» del panel (routes/panelInternacional.ts): las conversaciones del modo
// internacional traducidas al español, solo para el usuario (4173) e Ignacio (1313). Pedido del 14-11-2026.
process.env.MARCA = 'carver';
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.INTERNACIONAL_PREFIJOS = '+91';
process.env.BITRIX_PORTAL_DOMAIN = 'portal.example.com';

const T0 = '2026-11-14T00:34:10.000Z';
const filas = [
  // Un turno de Latinoamérica antes de entrar al modo: no se muestra.
  { dialog_id: 'chat1', ts: '2026-11-14T00:30:00.000Z', type: 'turn', crm_entity: null, detail: { message: 'Hola', reply: 'Hola, ¿en qué te ayudo?' } },
  { dialog_id: 'chat1', ts: T0, type: 'negociacion_internacional', crm_entity: 'deal#3754693', detail: { etapa: 'C73:UC_173429' } },
  {
    dialog_id: 'chat1',
    ts: '2026-11-14T00:34:40.000Z',
    type: 'turn',
    crm_entity: 'deal#3754693',
    detail: { message: 'Hello! Can I get more info on this?', reply: 'Hi! It is a 16-week live-online course.', internacional: true },
  },
  { dialog_id: 'chat1', ts: '2026-11-14T00:35:00.000Z', type: 'tool_call', crm_entity: 'deal#3754693', detail: { name: 'registrar_interes_crm', input: { email: 'x@example.com' }, ok: true } },
  {
    dialog_id: 'chat1',
    ts: '2026-11-14T00:35:20.000Z',
    type: 'turn',
    crm_entity: 'deal#3754693',
    detail: { message: '[URL=https://cdn.example.com/a.oga]Open[/URL] (el cliente envió un audio que no se pudo transcribir)', reply: 'Could you type it?', internacional: true },
  },
  { dialog_id: 'chat1', ts: '2026-11-14T00:36:00.000Z', type: 'derivacion_internacional', crm_entity: 'deal#3754693', detail: { motivo: 'Pago informado: USD 400', pago: true } },
  { dialog_id: 'chat2', ts: '2026-11-14T02:00:00.000Z', type: 'turn', crm_entity: null, detail: { message: 'Namaste', reply: 'Namaste! How can I help?', internacional: true } },
];

let llamadasModelo = 0;
mock.module('../src/ai/client.ts', {
  namedExports: {
    anthropic: {
      messages: {
        create: async (req: any) => {
          llamadasModelo++;
          return { content: [{ type: 'text', text: `[ES] ${req.messages[0].content}` }], usage: {} };
        },
      },
    },
    REASONER: 'modelo-de-prueba',
    CLASSIFIER: 'modelo-de-prueba',
  },
});
mock.module('../src/store/db.ts', {
  namedExports: {
    dbFilasInternacionales: async (o: { dialogId?: string } = {}) => (o.dialogId ? filas.filter((f) => f.dialog_id === o.dialogId) : filas),
    dbInsertAudit: async () => {},
    dbAcumularTokens: async () => {},
  },
});

const { armarConversaciones, puedeVerConversacionesInternacionales, limpiarTexto } = await import('../src/core/conversacionesInternacionales');
const { panelConversacionesInternacionales, panelConversacionInternacional, seccionInternacionalVisible } = await import('../src/routes/panelInternacional');

function respuesta(editorId: number) {
  const r: any = { statusCode: 200, locals: { editor: { id: editorId, nombre: 'X' } }, cuerpo: undefined };
  r.status = (c: number) => ((r.statusCode = c), r);
  r.json = (b: any) => ((r.cuerpo = b), r);
  return r;
}

beforeEach(() => {
  llamadasModelo = 0;
});

test('solo el usuario (4173) e Ignacio (1313) ven la sección', () => {
  assert.equal(puedeVerConversacionesInternacionales(4173), true);
  assert.equal(puedeVerConversacionesInternacionales(1313), true);
  assert.equal(puedeVerConversacionesInternacionales(62741), false, 'otros editores del panel no');
  assert.equal(puedeVerConversacionesInternacionales(307929), false);
  assert.equal(seccionInternacionalVisible(4173), true);
});

test('arma cada conversación con sus turnos del modo India y lo que pasó entremedio', () => {
  const [c2, c1] = armarConversaciones(filas as any);
  assert.equal(c2.dialogId, 'chat2', 'la más reciente primero');
  assert.equal(c1.turnos.length, 2, 'el turno previo en español no es del modo India');
  assert.equal(c1.dealId, 3754693);
  assert.equal(c1.dejoCorreo, true);
  assert.equal(c1.informoPago, true);
  assert.equal(c1.pidioAyuda, false);
  assert.deepEqual(c1.eventos.map((e) => e.tipo), ['negociacion', 'correo', 'pago']);
  assert.equal(c1.turnos[1].cliente, '(audio que no se pudo oír)');
  assert.equal(limpiarTexto('[URL=https://x.y/z]Open[/URL]'), '[adjunto]');
});

test('los audios se leen como audios: transcrito, «(audio) …»; sin transcribir, se dice', () => {
  assert.equal(limpiarTexto('[URL=https://x.y/a.oga]Open[/URL] [voice message] किसका number है?'), '(audio) किसका number है?');
  assert.equal(
    limpiarTexto('[URL=https://x.y/a.oga]Open[/URL] (el cliente envió un audio que no se pudo transcribir; pídele amablemente que escriba su consulta)'),
    '(audio que no se pudo oír)',
  );
  assert.equal(
    limpiarTexto('[URL=https://x.y/a.oga]Open[/URL] (the person sent a voice message that could not be transcribed; reply in their language and politely ask them to type their question)'),
    '(audio que no se pudo oír)',
    'la nota del modo India, en inglés',
  );
});

test('la lista: 403 para otros editores, y para ellos el resumen sin traducir nada', async () => {
  const otro = respuesta(62741);
  await panelConversacionesInternacionales({} as any, otro);
  assert.equal(otro.statusCode, 403);

  const r = respuesta(4173);
  await panelConversacionesInternacionales({} as any, r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.cuerpo.resumen, { personas: 2, dejaronCorreo: 1, informaronPago: 1, pidieronAyuda: 0 });
  const c1 = r.cuerpo.conversaciones.find((c: any) => c.dialogId === 'chat1');
  assert.equal(c1.dealUrl, 'https://portal.example.com/crm/deal/details/3754693/');
  assert.equal(c1.mensajes, 2);
  assert.equal(llamadasModelo, 0, 'la lista no traduce');
  assert.doesNotMatch(JSON.stringify(r.cuerpo), /x@example\.com/, 'no expone el correo');
});

test('una conversación se traduce al abrirla, una sola vez; lo que ya está en español no se traduce', async () => {
  const r = respuesta(1313);
  await panelConversacionInternacional({ params: { dialogId: 'chat1' } } as any, r);
  assert.equal(r.statusCode, 200);
  const [t1, t2] = r.cuerpo.turnos;
  assert.equal(t1.cliente.original, 'Hello! Can I get more info on this?');
  assert.equal(t1.cliente.es, '[ES] Hello! Can I get more info on this?');
  assert.equal(t1.bot.es, '[ES] Hi! It is a 16-week live-online course.');
  assert.equal(t2.cliente.es, t2.cliente.original, 'tiene tildes: ya está en español');
  assert.equal(llamadasModelo, 3);
  assert.deepEqual(r.cuerpo.eventos.map((e: any) => e.tipo), ['negociacion', 'correo', 'pago']);

  const otra = respuesta(1313);
  await panelConversacionInternacional({ params: { dialogId: 'chat1' } } as any, otra);
  assert.equal(llamadasModelo, 3, 'la segunda vez sale de lo guardado');
});

test('una conversación: 403 para otros editores y 404 para un id que no es de chat', async () => {
  const otro = respuesta(62741);
  await panelConversacionInternacional({ params: { dialogId: 'chat1' } } as any, otro);
  assert.equal(otro.statusCode, 403);
  const malo = respuesta(4173);
  await panelConversacionInternacional({ params: { dialogId: '../etc' } } as any, malo);
  assert.equal(malo.statusCode, 404);
  const noEsta = respuesta(4173);
  await panelConversacionInternacional({ params: { dialogId: 'chat999' } } as any, noEsta);
  assert.equal(noEsta.statusCode, 404);
});

test('la página trae el botón oculto y la meta que lo habilita', () => {
  const html = readFileSync(new URL('../public/panel/index.html', import.meta.url), 'utf8');
  assert.match(html, /<meta name="panel-extras" content="\{\{EXTRAS\}\}">/);
  assert.match(html, /data-seccion="internacional" hidden>Conversaciones India</);
  assert.match(html, /id="vista-internacional" hidden/);
});
