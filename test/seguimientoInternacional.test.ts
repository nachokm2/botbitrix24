import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Recordatorios del modo internacional (piloto de India). Pedido del usuario el 15-11-2026: «con 5».
// Hasta ese día el modo internacional no tenía ninguno, porque los de Latinoamérica están en español,
// en la hora de Chile (las 9:00 de Chile son las 17:30 de India) y terminan con el contacto de un
// asesor, que allá no existe. WhatsApp solo deja escribir sin plantilla dentro de las 24 h desde el
// último mensaje de la persona: los cinco caben ahí.
process.env.MARCA = 'carver';
process.env.NODE_ENV = 'test';
process.env.HORARIO_ASESORES_ACTIVO = 'false';

const enviados: Array<{ method: string; params: any }> = [];
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: async (method: string, params: any) => {
      enviados.push({ method, params });
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
mock.module('../src/crm/directory.ts', {
  namedExports: {
    getIdentidadAsesor: async () => ({ nombre: 'Asesora', telefono: '+56911112222', email: 'asesora@carver.university' }),
    getUsuarios: async () => [],
    getDealInfo: async () => null,
    getDealAsesores: async () => [],
    esEmpleadoBitrix: async () => false,
    getDatosConocidosDeEntidades: async () => ({}),
  },
});

const TEXTOS = [
  'Did you get a chance to look at the two tracks? I can tell you which one fits your work.',
  'Would you prefer a quick summary of the projects or of the weekly schedule?',
  'The live classes are recorded, so a busy week does not hold you back. Write whenever you like.',
  'Happy to explain in two lines how enrolment works, if that helps.',
  'Maybe now is not the moment, and that is fine; write here whenever it suits you.',
];
let llamadas = 0;
const cola: string[] = [];
const sistemas: string[] = [];
const pedidos: any[][] = [];
// Lo que contesta el clasificador de «¿viene por el programa?» (17-11-2026); va aparte de la cola de
// recordatorios para no consumirla.
let clasificacion = 'REMINDERS';
const clasificados: string[] = [];
mock.module('../src/ai/client.ts', {
  namedExports: {
    anthropic: {
      messages: {
        create: async (req: any) => {
          if (String(req.system).includes('keep sending this person reminders')) {
            clasificados.push(String(req.messages?.[0]?.content ?? ''));
            return { content: [{ type: 'text', text: clasificacion }], usage: {} };
          }
          sistemas.push(String(req.system));
          pedidos.push(req.messages ?? []);
          const text = cola.length ? cola.shift()! : TEXTOS[llamadas++ % TEXTOS.length];
          return { content: [{ type: 'text', text }], usage: {} };
        },
      },
    },
    REASONER: 'claude-test-sonnet',
    CLASSIFIER: 'claude-test-haiku',
  },
});
mock.module('../src/store.ts', {
  namedExports: {
    getState: async () => ({ auth: { domain: 'test.bitrix24.com', access_token: 'tok' }, botId: 1 }),
    setAuth: async () => {},
    setBotId: async () => {},
    setAppToken: async () => {},
    requireAuth: async () => ({ domain: 'test.bitrix24.com', access_token: 'tok' }),
    EMPTY_AUTH: { domain: '', access_token: '' },
  },
});

const zsets = new Map<string, Map<string, number>>();
const kvStore = new Map<string, string>();
const fakeRedis = {
  zadd: async (key: string, score: number, member: string) => {
    if (!zsets.has(key)) zsets.set(key, new Map());
    zsets.get(key)!.set(member, score);
    return 1;
  },
  zrem: async (key: string, member: string) => (zsets.get(key)?.delete(member) ? 1 : 0),
  zrangebyscore: async (key: string, _min: string, max: number) =>
    [...(zsets.get(key)?.entries() ?? [])].filter(([, s]) => s <= max).map(([m]) => m),
  zscore: async () => null,
  hincrby: async () => 1,
  exists: async () => 0,
  get: async () => null,
  set: async () => 'OK',
  incr: async () => 1,
};
mock.module('../src/store/kv.ts', {
  namedExports: {
    getRedisClient: () => fakeRedis,
    getJson: async (key: string) => (kvStore.has(key) ? JSON.parse(kvStore.get(key)!) : null),
    getJsonOrThrow: async (key: string) => (kvStore.has(key) ? JSON.parse(kvStore.get(key)!) : null),
    setJson: async (key: string, val: unknown) => void kvStore.set(key, JSON.stringify(val)),
    kvDel: async (key: string) => void kvStore.delete(key),
    once: async () => true,
  },
});

const seg = await import('../src/ai/seguimiento');
const { pideNoMolestar, prometioNoEscribir } = await import('../src/crm/exclusion');
const { config } = await import('../src/config');

const PASOS = 'seguimiento:pasos:due';
const TRANSFER = 'seguimiento:transferencia:due';
const CONVERSACION = [
  { role: 'user', content: 'Hello! Can I get more info on this?\n\nPut AI to Work' },
  { role: 'assistant', content: [{ type: 'text', text: 'Hi! Applied AI & Automation is a 16-week live-online course. What kind of work do you do?' }] },
  { role: 'user', content: "I'm a regional manager, I don't code" },
  { role: 'assistant', content: [{ type: 'text', text: 'Then the Builder Lite track fits you. Would you like to enrol, or do you have more questions?' }] },
];
const plan = (dialogId: string) => JSON.parse(kvStore.get(`seguimiento:plan:${dialogId}`) ?? 'null');
const ist = (t: number) => seg.horaEn(new Date(t), 'Asia/Kolkata');

async function vencerYBarrer(dialogId: string) {
  zsets.get(PASOS)?.set(dialogId, 0);
  await seg.barrerPasosVencidos();
}

test('config: el modo internacional trae cinco recordatorios en Carver, de 9:00 a 21:00 hora de India', () => {
  assert.deepEqual(config.seguimientoInternacionalHoras, [3, 5, 7, 9, 23]);
  assert.equal(config.seguimientoInternacionalHoraInicio, 9);
  assert.equal(config.seguimientoInternacionalHoraFin, 21);
});

test('plan: todos en la franja de India y dentro de las 23,5 h de WhatsApp (caso Sumantra: escribió a las 19:14 IST)', () => {
  const desde = Date.parse('2026-11-15T13:44:00Z'); // 19:14 en India
  const pasos = seg.planDeRecordatorios(desde, [3, 5, 7, 9, 23], seg.proximoHorarioInternacional);
  assert.equal(pasos.length, 5);
  for (const p of pasos) {
    assert.ok(ist(p) >= 9 && ist(p) < 21, `fuera de la franja: ${new Date(p).toISOString()}`);
    assert.ok(p - desde <= 23.5 * 3600_000, 'fuera de la ventana de 24 h');
  }
  for (let i = 1; i < pasos.length; i++) assert.ok(pasos[i] - pasos[i - 1] >= 2 * 3600_000, 'dos recordatorios pegados');
  // Con la franja de Chile (9 a 21 en Santiago) habrían salido de madrugada en India.
  const chile = seg.planDeRecordatorios(desde, [3, 5, 7, 9, 23]);
  assert.ok(chile.some((p) => ist(p) < 9 || ist(p) >= 21));
});

test('programarSeguimientoInternacional: plan marcado como internacional, sin derivación por silencio', async () => {
  const d = 'chat-intl-1';
  kvStore.set(`mem:${d}`, JSON.stringify(CONVERSACION));
  zsets.set(TRANSFER, new Map([[d, 1]]));
  await seg.programarSeguimientoInternacional(d, { deal: 3759446, contact: 3267672 }, '9001');
  const p = plan(d);
  assert.equal(p.intl, true);
  assert.ok(p.pasos.length >= 3 && p.pasos.length <= 5);
  assert.ok(zsets.get(PASOS)?.has(d));
  assert.ok(!zsets.get(TRANSFER)?.has(d), 'en India no hay asesor al que derivar');
});

test('barrido: el recordatorio sale con el prompt en inglés y el cierre sin contacto de asesor', async () => {
  const d = 'chat-intl-2';
  kvStore.set(`mem:${d}`, JSON.stringify(CONVERSACION));
  await seg.programarSeguimientoInternacional(d, { deal: 1 }, '9002');
  // Que la franja no dependa de la hora a la que corre la prueba.
  config.seguimientoInternacionalHoraInicio = 0;
  config.seguimientoInternacionalHoraFin = 24;
  try {
    const total = plan(d).pasos.length;
    enviados.length = 0;
    sistemas.length = 0;
    for (let i = 0; i < total; i++) await vencerYBarrer(d);
    const mensajes = enviados.filter((e) => e.method === 'imbot.message.add').map((e) => String(e.params.MESSAGE));
    assert.equal(mensajes.length, total);
    assert.ok(sistemas.every((s) => s.includes("Carver University's admissions assistant") && s.includes('never in Spanish')));
    assert.ok(!/asesora@|\+56/.test(mensajes.at(-1)!), 'el cierre no lleva contacto de asesor');
    const ultimo = auditorias.filter((a) => a.type === 'seguimiento' && a.dialogId === d).at(-1);
    assert.equal(ultimo.detail.internacional, true);
  } finally {
    config.seguimientoInternacionalHoraInicio = 9;
    config.seguimientoInternacionalHoraFin = 21;
  }
});

test('17-11: a quien solo mandó el mensaje del anuncio, dos recordatorios (el primero y el de cierre)', async () => {
  config.seguimientoInternacionalHoraInicio = 0;
  config.seguimientoInternacionalHoraFin = 24;
  try {
    const d = 'chat-intl-solo-anuncio';
    kvStore.set(
      `mem:${d}`,
      JSON.stringify([
        { role: 'user', content: 'Hello! Can I get more info on this?\n\nhttps://fb.me/x\n\nPut AI to Work' },
        { role: 'assistant', content: [{ type: 'text', text: 'Hi! It is a 16-week live-online course, in English. Do you work with code?' }] },
        { role: 'user', content: 'https://www.instagram.com/reel/abc' },
        { role: 'assistant', content: [{ type: 'text', text: 'I cannot open links here. Would you like to know how it works?' }] },
      ]),
    );
    await seg.programarSeguimientoInternacional(d, { deal: 1 }, '9011');
    assert.equal(plan(d).pasos.length, 2);
    const d2 = 'chat-intl-conversa';
    kvStore.set(`mem:${d2}`, JSON.stringify(CONVERSACION));
    await seg.programarSeguimientoInternacional(d2, { deal: 1 }, '9012');
    assert.equal(plan(d2).pasos.length, 5, 'quien conversó recibe los cinco');
  } finally {
    config.seguimientoInternacionalHoraInicio = 9;
    config.seguimientoInternacionalHoraFin = 21;
  }
});

test('17-11: a quien no viene por el programa (pide dinero, busca trabajo, no lee inglés) no se le insiste', async () => {
  const d = 'chat-intl-noprospecto';
  kvStore.set(`mem:${d}`, JSON.stringify(CONVERSACION));
  await seg.programarSeguimientoInternacional(d, { deal: 1 }, '9010');
  config.seguimientoInternacionalHoraInicio = 0;
  config.seguimientoInternacionalHoraFin = 24;
  clasificacion = 'NO_REMINDERS: pide que le transfieran dinero';
  try {
    enviados.length = 0;
    clasificados.length = 0;
    await vencerYBarrer(d);
    assert.equal(enviados.filter((e) => e.method === 'imbot.message.add').length, 0);
    assert.match(clasificados[0], /regional manager/, 'el clasificador lee la conversación');
    const omitido = auditorias.filter((a) => a.type === 'seguimiento_omitido' && a.dialogId === d).at(-1);
    assert.equal(omitido.detail.motivo, 'no_es_prospecto');
    assert.equal(omitido.detail.detalle, 'pide que le transfieran dinero');
    assert.equal(plan(d), null, 'la secuencia termina');
  } finally {
    clasificacion = 'REMINDERS';
    config.seguimientoInternacionalHoraInicio = 9;
    config.seguimientoInternacionalHoraFin = 21;
  }
});

test('barrido: un recordatorio en español o con emoji se pide de nuevo y, si sigue mal, sale el texto seguro en inglés', async () => {
  const d = 'chat-intl-3';
  kvStore.set(`mem:${d}`, JSON.stringify(CONVERSACION));
  await seg.programarSeguimientoInternacional(d, { deal: 1 }, '9003');
  config.seguimientoInternacionalHoraInicio = 0;
  config.seguimientoInternacionalHoraFin = 24;
  try {
    enviados.length = 0;
    pedidos.length = 0;
    cola.push('¡Hola! ¿Pudiste revisar el programa? 😊', 'Hola, ¿te quedó alguna duda?', 'Seguimos en contacto 😊');
    await vencerYBarrer(d);
    const msg = String(enviados.find((e) => e.method === 'imbot.message.add')?.params.MESSAGE);
    assert.ok(/^[\x00-\x7F]+$/.test(msg), `debía salir el texto seguro en inglés: ${msg}`);
    const correccion = String(pedidos.at(-1)?.at(-1)?.content ?? '');
    assert.match(correccion, /That message does not work/);
  } finally {
    config.seguimientoInternacionalHoraInicio = 9;
    config.seguimientoInternacionalHoraFin = 21;
  }
});

test('barrido: fuera de la franja de India no sale; se corre a la mañana siguiente de allá', async () => {
  const d = 'chat-intl-4';
  kvStore.set(`mem:${d}`, JSON.stringify(CONVERSACION));
  await seg.programarSeguimientoInternacional(d, { deal: 1 }, '9004');
  // Una franja vacía a esta hora: la de una sola hora que no es la actual.
  const h = seg.horaEn(new Date(), 'Asia/Kolkata');
  config.seguimientoInternacionalHoraInicio = (h + 2) % 24;
  config.seguimientoInternacionalHoraFin = ((h + 2) % 24) + 1;
  try {
    enviados.length = 0;
    await vencerYBarrer(d);
    assert.equal(enviados.filter((e) => e.method === 'imbot.message.add').length, 0);
    const nuevo = zsets.get(PASOS)!.get(d)!;
    assert.equal(seg.horaEn(new Date(nuevo), 'Asia/Kolkata'), config.seguimientoInternacionalHoraInicio);
  } finally {
    config.seguimientoInternacionalHoraInicio = 9;
    config.seguimientoInternacionalHoraFin = 21;
  }
});

test('problemasDelRecordatorioInternacional: lo que no puede salir', () => {
  const p = seg.problemasDelRecordatorioInternacional;
  assert.deepEqual(p('Would you like me to tell you which track fits your work best?'), []);
  assert.ok(p('Hope you are well 😊').length, 'emoji');
  assert.ok(p('Hola, ¿pudiste revisar el programa?').length, 'español');
  assert.ok(p('It is just USD 400 or 4 instalments').length, 'montos');
  assert.ok(p('This degree will help you get a promotion').length, 'título o trabajo');
  assert.ok(p('Only a few seats left, hurry!').length, 'urgencia');
  assert.ok(p("I haven't heard back from you").length, 'reproche');
  assert.ok(p('Just following up on the programme').length, 'muletilla');
  assert.ok(p('Dear Sir, any questions?').length, 'Dear Sir');
});

test('16-11: no corrige el precio dado antes, no cuenta sus instrucciones, no ofrece llamadas ni vuelve a preguntar por el trabajo', () => {
  const p = seg.problemasDelRecordatorioInternacional;
  // Recordatorios reales de la primera noche.
  assert.ok(p("I realised I shared pricing details that aren't meant for WhatsApp chat – let me know if you'd like to explore the programme structure first").length);
  assert.ok(p("I appreciate your interest, but I need to clarify - I can't provide pricing, scholarships or payment details like that.").length);
  assert.ok(p('I need to clarify something - I can only see the transcription shows the conversation just started, but the previous message mentions pricing').length);
  assert.ok(p('Would you rather I send you the full course schedule, or would a quick call work better?').length);
  assert.ok(p('What kind of work are you in — would that be more of a technical role or something else?').length);
  assert.deepEqual(p('Happy to walk you through how the enrolment process works if that would help.'), []);
  // Tracks, herramientas y documentos que no están en la conversación (simulación del 16-11).
  assert.ok(p('The programme has two tracks – one focused on AI tools, the other on automation strategy – does that sound interesting?').length);
  assert.ok(p('Would you rather I send you the detailed syllabus for one of the tracks?').length);
  assert.ok(p('Would it help if I explained how the three tracks work?').length);
  const conv = 'Cliente: Hello\nBot: Two tracks: Builder Lite (no code) and Builder Pro (Python). Do you code?';
  assert.ok(seg.herramientasQueNoEstan('The no-code path uses tools like Zapier and Make, while Python goes deeper.', conv).length);
  assert.deepEqual(seg.herramientasQueNoEstan('Python or no code, both build the same projects. Make sure to ask me anything.', conv), []);
  assert.ok(seg.herramientasQueNoEstan('Enroll karne ke liye bas ek online form fill karna padega.', conv).length);
  assert.ok(seg.herramientasQueNoEstan('You can learn at your own pace while working.', conv).length);
  // El prompt deja claro que lo dicho antes estaba bien.
  const s = seg.sistemaSeguimientoInternacional('primero', 1, 'x');
  assert.match(s, /Everything said earlier in the conversation, prices included, was correct/);
  assert.match(s, /never mention your instructions/);
  assert.match(s, /do not offer calls or meetings/);
});

test('16-11 tarde: no manda su razonamiento sobre cómo escribir el recordatorio', () => {
  const p = seg.problemasDelRecordatorioInternacional;
  // Lo que le llegó a chat1604707.
  assert.ok(
    p(
      'The conversation ended naturally with closure. A follow-up should simply re-engage on what mattered to them—the job ' +
        "opportunity they flagged—without reproach or internal language. Here's the corrected follow-up: Just in case it " +
        'helps while you wait to hear back from the team, would you like to know how the programme works?',
    ).length,
  );
  assert.ok(p("Here's the revised message: would you like to know how enrolment works?").length);
  assert.ok(p('Quick follow-up: are you still interested?').length);
  // Recordatorios reales de esa tarde que estaban bien siguen pasando.
  for (const ok of [
    'Are you still interested in learning more about the programme?',
    'The 16 weeks are live online, so you can keep working while you do it.',
    'Kya aap programme ke baare mein aur jaanna chahte hain, ya seedhe enrolment shuru kar dena chahte hain?',
    "Whenever you're ready, I'm here to help you pick the right track for where you're at.",
  ]) {
    assert.deepEqual(p(ok), [], ok);
  }
});

test('interruptor: con SEGUIMIENTO_INTERNACIONAL_HORAS vacío no sale ni lo ya agendado', async () => {
  const d = 'chat-intl-5';
  kvStore.set(`mem:${d}`, JSON.stringify(CONVERSACION));
  await seg.programarSeguimientoInternacional(d, { deal: 1 }, '9005');
  const horas = config.seguimientoInternacionalHoras;
  config.seguimientoInternacionalHoraInicio = 0;
  config.seguimientoInternacionalHoraFin = 24;
  config.seguimientoInternacionalHoras = [];
  try {
    enviados.length = 0;
    await vencerYBarrer(d);
    assert.equal(enviados.filter((e) => e.method === 'imbot.message.add').length, 0);
    assert.equal(auditorias.filter((a) => a.type === 'seguimiento_omitido' && a.dialogId === d).at(-1)?.detail.motivo, 'internacional_apagado');
    assert.equal(plan(d), null, 'la secuencia queda terminada');
  } finally {
    config.seguimientoInternacionalHoras = horas;
    config.seguimientoInternacionalHoraInicio = 9;
    config.seguimientoInternacionalHoraFin = 21;
  }
});

test('baja y rechazo en inglés: cortan la secuencia', () => {
  assert.equal(seg.esRechazo('Not interested, thanks'), true);
  assert.equal(seg.esRechazo('No thank you'), true);
  assert.equal(seg.esRechazo('No thanks, how much is it?'), false);
  assert.equal(seg.esSoloCortesia('Thank you'), true);
  assert.equal(seg.esSoloCortesia('Thanks, what is the fee?'), false);
  assert.equal(
    seg.motivoPorLoConversado('Cliente: hi\nBot: Welcome!\nCliente: I am not interested\nBot: Understood.\nCliente: thanks', true),
    'rechazo',
  );
  assert.equal(pideNoMolestar("Please don't message me again"), true);
  assert.equal(pideNoMolestar('Stop messaging me'), true);
  assert.equal(pideNoMolestar("Don't call, just text me"), false);
  assert.equal(prometioNoEscribir("Understood, I won't message you again."), true);
});

test('repiteLoAnteriorInternacional: mismo comienzo o frase copiada', () => {
  const anteriores = ['Did you get a chance to look at the tracks? I can help you choose.'];
  assert.ok(seg.repiteLoAnteriorInternacional('Did you get a chance to read it?', anteriores).length);
  assert.ok(seg.repiteLoAnteriorInternacional('Happy to help: did you get a chance to look at the tracks?', anteriores).length);
  assert.deepEqual(seg.repiteLoAnteriorInternacional('Would a short summary of the projects help?', anteriores), []);
});
