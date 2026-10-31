import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// El bot se queda con la conversación cuando no hay quién la reciba (core/retenerChat.ts). Caso real
// del sábado 31-10-2026: cuatro conversaciones derivadas a una asesora que volvía el lunes, dos de ellas
// con la ficha de matrícula a medio llenar, y las respuestas siguientes no las leyó nadie.
process.env.MARCA = 'carver';
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.SCORE_ESCALAR = '80';

const llamadas: Array<{ method: string; params: any }> = [];
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: async (method: string, params: any) => {
      llamadas.push({ method, params });
      return {};
    },
    callCrm: async (method: string, params: any) => {
      llamadas.push({ method, params });
      return {};
    },
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: {}, total: 0 }),
    callWebhook: async () => ({}),
  },
});
const auditorias: any[] = [];
mock.module('../src/obs/audit.ts', { namedExports: { audit: async (e: any) => void auditorias.push(e) } });
const derivadas: unknown[] = [];
mock.module('../src/crm/asignacionAsesores.ts', {
  namedExports: {
    asignarAsesorPorTurno: async () => true,
    olvidarNoPiloto: async () => {},
    derivarAResponsableFijo: async (e: unknown) => {
      derivadas.push(e);
      return true;
    },
    programaCoincide: () => false,
  },
});
mock.module('../src/ai/client.ts', {
  namedExports: {
    anthropic: {
      messages: {
        create: async () => ({
          content: [{ type: 'text', text: '{"score": 92, "intencion": "alta", "sentimiento": "positivo", "justificacion": "quiere matricularse"}' }],
          usage: {},
        }),
      },
    },
    REASONER: 'x',
    CLASSIFIER: 'y',
  },
});

const { config } = await import('../src/config');
const { motivoParaRetener, fichaDeMatriculaEnCurso } = await import('../src/core/retenerChat');
const { executeTool } = await import('../src/ai/toolRunner');
const { procesarScoring } = await import('../src/ai/scoring');
const { setHistory } = await import('../src/ai/memory');
const { getSession } = await import('../src/session');
const { WHATSAPP_PROFILE } = await import('../src/core/channel');

/** El equipo trabaja todos los días a toda hora, o ningún día: así la prueba no depende de la hora. */
const equipo = (trabajando: boolean) => {
  config.horarioAsesoresDias = trabajando ? [0, 1, 2, 3, 4, 5, 6] : [];
  config.horarioAsesoresInicio = '00:00';
  config.horarioAsesoresFin = '24:00';
};
const ficha = (completo: boolean) => [
  { role: 'user', content: 'Sí, quiero matricularme' },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'f1', name: 'registrar_datos_matricula', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'f1', content: JSON.stringify({ completo, faltan: completo ? [] : ['domicilio'] }) }] },
  { role: 'assistant', content: 'Anotado. Ahora su domicilio.' },
];
const auth = { domain: 't', access_token: 't' } as any;
const ctx = (id: string) =>
  ({
    auth,
    conversationId: id,
    chatId: '1562099',
    botId: 1,
    crmEntities: { deal: 3705653 },
    crmEntity: { type: 'deal', id: 3705653 },
    profile: WHATSAPP_PROFILE,
  }) as any;
const escalada = (id: string) => [
  { role: 'user', content: 'Quiero matricularme ya en la maestría' },
  { role: 'assistant', content: 'Excelente decisión.' },
];

test('ficha de matrícula: en curso hasta que la herramienta diga que está completa', () => {
  assert.equal(fichaDeMatriculaEnCurso([]), false, 'sin ficha empezada');
  assert.equal(fichaDeMatriculaEnCurso(ficha(false)), true);
  assert.equal(fichaDeMatriculaEnCurso(ficha(true)), false);
});

test('motivo para retener: fuera de horario, o con la ficha en curso aunque el equipo esté', () => {
  equipo(false);
  assert.equal(motivoParaRetener(), 'fuera_de_horario');
  equipo(true);
  assert.equal(motivoParaRetener(), null);
  assert.equal(motivoParaRetener({ fichaEnCurso: true }), 'ficha_en_curso');
});

test('escalar_a_humano fuera de horario: la asesora recibe la negociación, pero el bot NO entrega la sesión', async () => {
  equipo(false);
  derivadas.length = 0;
  const c = ctx('chat-ret-1');
  const r = await executeTool('escalar_a_humano', { motivo: 'quiere hablar con una persona' }, c);
  assert.equal(r.retenida, true);
  assert.match(r.mensaje, /TÚ sigues atendiendo/);
  assert.equal(c.transferirAOperador, undefined, 'no se entrega la sesión');
  assert.equal(derivadas.length, 1, 'la negociación igual va a la asesora, con su tarea');
  assert.ok(auditorias.some((a) => a.type === 'derivacion_retenida' && a.detail.motivo === 'fuera_de_horario'));
  assert.notEqual((await getSession('chat-ret-1')).humanTookOver, true, 'el bot no queda mudo');
});

test('escalar_a_humano en horario: se entrega como siempre', async () => {
  equipo(true);
  const c = ctx('chat-ret-2');
  const r = await executeTool('escalar_a_humano', { motivo: 'quiere hablar con una persona' }, c);
  assert.notEqual(r.retenida, true);
  assert.equal(c.transferirAOperador, true);
});

test('puntaje alto con la ficha a medio llenar, en horario: urgente para la asesora, pero el bot sigue', async () => {
  equipo(true);
  llamadas.length = 0;
  await setHistory('chat-ret-3', ficha(false));
  await procesarScoring({ dialogId: 'chat-ret-3', chatId: 125, botId: 1, crmEntities: {}, auth });
  assert.ok(!llamadas.some((l) => l.method === 'imopenlines.bot.session.operator'), 'no entrega la sesión');
  assert.notEqual((await getSession('chat-ret-3')).humanTookOver, true);
  assert.ok(auditorias.some((a) => a.type === 'auto_escalation' && a.dialogId === 'chat-ret-3' && a.detail.retenida === 'ficha_en_curso'));
});

test('puntaje alto sin ficha, en horario: se entrega como siempre', async () => {
  equipo(true);
  llamadas.length = 0;
  await setHistory('chat-ret-4', escalada('chat-ret-4'));
  await procesarScoring({ dialogId: 'chat-ret-4', chatId: 126, botId: 1, crmEntities: {}, auth });
  assert.ok(llamadas.some((l) => l.method === 'imopenlines.bot.session.operator'));
});

test('puntaje alto fuera de horario: el bot sigue', async () => {
  equipo(false);
  llamadas.length = 0;
  await setHistory('chat-ret-5', escalada('chat-ret-5'));
  await procesarScoring({ dialogId: 'chat-ret-5', chatId: 127, botId: 1, crmEntities: {}, auth });
  assert.ok(!llamadas.some((l) => l.method === 'imopenlines.bot.session.operator'));
});
