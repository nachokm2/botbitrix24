import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Secuencia de contacto de Carver (hallazgo 8) y su identidad (hallazgo 1). Lo que mostraron los logs
// de producción del 10 al 13 de octubre de 2026: 100+ primeros recordatorios y CERO segundos, aunque
// el segundo estaba configurado a las 10 h. Causa: la memoria del chat vence a las 6 h y el segundo
// recordatorio la encontraba vacía y se descartaba en silencio. Además, el texto del recordatorio se
// generaba como "Sofía, asesora de Postgrados de la Universidad Autónoma de Chile".
//
// Reunión de Carver del 02-11-2026: la secuencia pasa a cinco mensajes (3, 5, 7, 9 y 23 h), el último
// con el WhatsApp y el correo del asesor a cargo, y sin derivación al asesor por silencio.
process.env.MARCA = 'carver';
process.env.NODE_ENV = 'test';
// Lo que quedó agendado con la secuencia anterior se sigue despachando hasta vaciarse.
process.env.SEGUIMIENTO_SEGUNDO_HORAS = '10';
// El horario de asesores se prueba aparte (horarioAsesores.test.ts). Estas pruebas miran el
// CONTENIDO del recordatorio, y con la regla activa no saldria ninguno en horario de oficina:
// dependerian de la hora a la que alguien corra el suite.
process.env.HORARIO_ASESORES_ACTIVO = 'false';

const enviados: Array<{ method: string; params: any }> = [];
const consultasCrm: string[] = [];
let fichaCrm: Record<string, unknown> = {};
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: async (method: string, params: any) => {
      enviados.push({ method, params });
      return {};
    },
    callCrm: async (method: string) => {
      consultasCrm.push(method);
      return fichaCrm;
    },
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: {} }),
    callWebhook: async () => ({}),
  },
});
const auditorias: any[] = [];
mock.module('../src/obs/audit.ts', { namedExports: { audit: async (e: any) => void auditorias.push(e) } });

// Responsable de cada negociación, como lo arma crm/directory.ts con el contacto entregado por la
// coordinación (crm/contactoAsesores.ts). La 2 no tiene WhatsApp entregado y la ficha trae un Gmail.
const identidades: Record<number, any> = {
  1: { nombre: 'Asesora Uno', telefono: '+56911112222', email: 'asesora.uno@carver.university' },
  2: { nombre: 'Asesora Dos', email: 'asesora.dos@gmail.com' },
};
mock.module('../src/crm/directory.ts', {
  namedExports: {
    getIdentidadAsesor: async (e: { deal?: number }) => identidades[e.deal ?? 0] ?? null,
    getUsuarios: async () => [],
    getDealInfo: async () => null,
    getDealAsesores: async () => [],
    esEmpleadoBitrix: async () => false,
    getDatosConocidosDeEntidades: async () => ({}),
  },
});

// Cada recordatorio sale distinto, como saldría del modelo: el guardián descarta lo que repite.
const TEXTOS = [
  '¿Pudo revisar lo de la maestría? Si le sirve, le cuento cuándo cierra la postulación.',
  '¿Le acomoda que le cuente cómo son las clases en vivo?',
  '¿Le sirve más empezar en la próxima cohorte?',
  '¿Le envío el detalle de la malla por aquí?',
  'Quizá no es el momento; sigo por acá cuando quiera retomarlo.',
];
let llamadas = 0;
let textoModelo: string | null = null;
// Respuestas del modelo en orden, para probar la corrección: si hay, mandan sobre lo demás.
const cola: string[] = [];
const sistemas: string[] = [];
const pedidos: any[][] = [];
let conversacionUsada = '';
mock.module('../src/ai/client.ts', {
  namedExports: {
    anthropic: {
      messages: {
        create: async (req: any) => {
          sistemas.push(String(req.system));
          pedidos.push(req.messages ?? []);
          conversacionUsada = String(req.messages?.[0]?.content ?? '');
          const text = cola.length ? cola.shift()! : (textoModelo ?? TEXTOS[llamadas++ % TEXTOS.length]);
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
const { marcarTraspaso } = await import('../src/session');
const { config } = await import('../src/config');
config.seguimientoHoraInicio = 0; // el barrido no depende de la hora a la que corre la prueba
config.seguimientoHoraFin = 24;

const PASOS = 'seguimiento:pasos:due';
const CONVERSACION = [
  { role: 'user', content: 'Hola, me interesa la Maestría en Inteligencia Artificial' },
  { role: 'assistant', content: [{ type: 'text', text: 'Con gusto. Es 100% en línea, con clases en vivo. ¿Le cuento el valor con la beca?' }] },
];

async function conversacionRespondida(dialogId: string, deal = 1) {
  kvStore.set(`mem:${dialogId}`, JSON.stringify(CONVERSACION));
  await seg.programarSeguimiento(dialogId, { deal }, '5001');
}
const plan = (dialogId: string) => JSON.parse(kvStore.get(`seguimiento:plan:${dialogId}`) ?? 'null');
/** Vence el paso pendiente del chat y corre el barrido, como si hubiera llegado su hora. */
async function correrPaso(dialogId: string) {
  zsets.get(PASOS)?.set(dialogId, Date.now() - 1000);
  await seg.barrerPasosVencidos();
}
const envios = (dialogId: string) => enviados.filter((e) => e.method === 'imbot.message.add' && e.params.DIALOG_ID === dialogId);
const omitido = (dialogId: string) => auditorias.find((a) => a.type === 'seguimiento_omitido' && a.dialogId === dialogId)?.detail?.motivo;
const sinNadaAgendado = (dialogId: string) => plan(dialogId) === null && !zsets.get(PASOS)?.has(dialogId);

test('cinco recordatorios: el primero retoma el hilo, los del medio buscan un sí o un no, y el último deja el WhatsApp y el correo del asesor', async () => {
  sistemas.length = 0;
  await conversacionRespondida('c-cinco');
  assert.equal(plan('c-cinco').pasos.length, 5);
  for (let i = 0; i < 5; i++) await correrPaso('c-cinco');

  const msgs = envios('c-cinco').map((e) => e.params.MESSAGE as string);
  assert.equal(msgs.length, 5);
  assert.match(sistemas[0], /retoma el hilo/);
  for (const s of sistemas.slice(1, 4)) assert.match(s, /le haga fácil contestar/);
  assert.match(sistemas[4], /ÚLTIMO mensaje/);
  assert.match(sistemas[4], /NO escribas teléfonos ni correos/, 'el contacto no lo escribe el modelo');
  // El número va con el formato de un celular chileno y tal como lo entregó la coordinación.
  assert.match(msgs[4], /Le dejo mi WhatsApp \+56 9 1111 2222 y mi correo asesora\.uno@carver\.university/);
  for (const m of msgs.slice(0, 4)) assert.doesNotMatch(m, /WhatsApp|@/, 'solo el último lleva el contacto');

  const ultimo = auditorias.filter((a) => a.type === 'seguimiento' && a.dialogId === 'c-cinco').at(-1);
  assert.deepEqual({ ...ultimo.detail, mensaje: undefined }, { mensaje: undefined, etapa: 5, de: 5, conContacto: true });
  assert.ok(sinNadaAgendado('c-cinco'), 'terminada la secuencia no queda nada agendado');
});

test('si la negociación queda con un asesor que atiende sin el bot, los recordatorios agendados no salen', async () => {
  await conversacionRespondida('c-sin-bot');
  config.asesoresSinBot = [777];
  config.embudosPropios = [];
  fichaCrm = { ASSIGNED_BY_ID: '777' };
  try {
    await correrPaso('c-sin-bot');
    assert.equal(envios('c-sin-bot').length, 0);
    assert.equal(omitido('c-sin-bot'), 'asesor_sin_bot');
    assert.ok(sinNadaAgendado('c-sin-bot'), 'la secuencia termina');
  } finally {
    config.asesoresSinBot = [];
    fichaCrm = {};
  }
});

test('nunca dos recordatorios pegados, ni de noche, y el último cabe en la ventana de 24 h de WhatsApp', () => {
  config.seguimientoHoraInicio = 9;
  config.seguimientoHoraFin = 21;
  try {
    // Un instante en punto a las 20:00 de Chile (el desfase de Chile es de horas enteras).
    let t = Date.now() - (Date.now() % 3600_000);
    while (seg.horaEnChile(new Date(t)) !== 20) t += 3600_000;
    for (const desde of [t, t + 2.5 * 3600_000, t - 10 * 3600_000]) {
      const pasos = seg.planDeRecordatorios(desde, [3, 5, 7, 9, 23]);
      assert.equal(pasos.length, 5, `cinco recordatorios respondiendo a las ${seg.horaEnChile(new Date(desde))}`);
      for (const p of pasos) {
        const h = seg.horaEnChile(new Date(p));
        assert.ok(h >= 9 && h < 21, `ninguno de noche (salió uno a las ${h})`);
      }
      for (let i = 1; i < pasos.length; i++) assert.ok(pasos[i] - pasos[i - 1] >= 2 * 3600_000, 'al menos dos horas entre uno y otro');
      assert.ok(pasos[4] - desde <= 23.5 * 3600_000, 'el último no se corre fuera de la ventana: se adelanta');
    }
  } finally {
    config.seguimientoHoraInicio = 0;
    config.seguimientoHoraFin = 24;
  }
});

test('Carver ya no deriva al asesor por silencio: solo cuando el caso escala', async () => {
  assert.equal(config.seguimientoTransferenciaHoras, 0);
  await conversacionRespondida('c-sin-derivar');
  assert.ok(!zsets.get('seguimiento:transferencia:due')?.has('c-sin-derivar'));
  // Una derivación agendada antes de apagarla vence sin derivar.
  if (!zsets.has('seguimiento:transferencia:due')) zsets.set('seguimiento:transferencia:due', new Map());
  zsets.get('seguimiento:transferencia:due')!.set('c-agendada', Date.now() - 1000);
  kvStore.set('seguimiento:entidades:c-agendada', JSON.stringify({ deal: 1 }));
  consultasCrm.length = 0;
  const destino = config.derivarATodo;
  (config as any).derivarATodo = 99; // con destino, derivar SÍ consultaría la negociación
  try {
    await seg.barrerTransferenciasVencidas();
  } finally {
    (config as any).derivarATodo = destino;
  }
  assert.ok(!zsets.get('seguimiento:transferencia:due')!.has('c-agendada'));
  assert.deepEqual(consultasCrm, [], 'ni siquiera mira la negociación');
});

test('el cierre no entrega el Gmail de la ficha ni un WhatsApp que la coordinación no dio', async () => {
  sistemas.length = 0;
  await conversacionRespondida('c-gmail', 2);
  for (let i = 0; i < 5; i++) await correrPaso('c-gmail');
  const ultimo = envios('c-gmail').at(-1)!.params.MESSAGE as string;
  assert.doesNotMatch(ultimo, /gmail|WhatsApp|Le dejo/);
  assert.doesNotMatch(sistemas.at(-1)!, /NO escribas teléfonos/, 'sin contacto que agregar, el prompt no lo anuncia');
});

test('el recordatorio de Carver habla como el asesor a cargo, no como "Sofía de Postgrados"', async () => {
  sistemas.length = 0;
  await conversacionRespondida('c-identidad');
  await correrPaso('c-identidad');
  assert.equal(envios('c-identidad').length, 1);
  assert.match(sistemas[0], /asesor a cargo de esta conversación en Carver University/);
  assert.match(sistemas[0], /NO nombres a otras personas del equipo/);
  assert.match(sistemas[0], /no empieces con "Veo que"/, 'la frase que delata a la IA está vetada');
  assert.match(sistemas[0], /nunca tuteas ni voseas/);
  assert.match(sistemas[0], /Usa SOLO lo que está en la conversación/);
  assert.doesNotMatch(sistemas[0], /Sof[ií]a|Universidad Autónoma|español de Chile/);
});

test('con la memoria del chat vencida, el paso siguiente sale igual y sabe lo que dijeron los anteriores', async () => {
  await conversacionRespondida('c-memoria');
  await correrPaso('c-memoria');
  const primero = envios('c-memoria')[0].params.MESSAGE as string;
  kvStore.delete('mem:c-memoria'); // la memoria vence a las 6 h; el paso siguiente puede ir a la mañana
  await correrPaso('c-memoria');
  assert.equal(envios('c-memoria').length, 2, 'se generó desde la instantánea de la conversación');
  assert.ok(conversacionUsada.includes(`Bot: ${primero}`), 'la instantánea suma cada recordatorio enviado');
});

test('sin conversación de dónde generar, el descarte queda auditado y la secuencia termina', async () => {
  await conversacionRespondida('c-vacio');
  kvStore.delete('mem:c-vacio');
  kvStore.delete('seguimiento:snapshot:c-vacio');
  await correrPaso('c-vacio');
  assert.equal(envios('c-vacio').length, 0);
  assert.equal(omitido('c-vacio'), 'sin_conversacion');
  assert.ok(sinNadaAgendado('c-vacio'));
});

test('fuera de la ventana de 24 h de WhatsApp no se envía (no llegaría), ni ese ni los que siguen', async () => {
  await conversacionRespondida('c-ventana');
  const snap = JSON.parse(kvStore.get('seguimiento:snapshot:c-ventana')!);
  kvStore.set('seguimiento:snapshot:c-ventana', JSON.stringify({ ...snap, clienteAt: Date.now() - 25 * 3600_000 }));
  await correrPaso('c-ventana');
  assert.equal(envios('c-ventana').length, 0);
  assert.equal(omitido('c-ventana'), 'fuera_ventana_24h');
  assert.ok(sinNadaAgendado('c-ventana'));
});

test('tope diario: con la cuota de 24 h cumplida ese paso no sale, pero la secuencia sigue', async () => {
  const hace = (h: number) => Date.now() - h * 3600_000;
  kvStore.set('seguimiento:enviados:c-tope', JSON.stringify([hace(5), hace(4), hace(3), hace(2), hace(1)]));
  await conversacionRespondida('c-tope');
  await correrPaso('c-tope');
  assert.equal(envios('c-tope').length, 0);
  assert.equal(omitido('c-tope'), 'tope_diario');
  assert.equal(plan('c-tope').siguiente, 1, 'queda agendado el paso siguiente');
  assert.ok(zsets.get(PASOS)!.has('c-tope'));
});

test('si la sesión se traspasó a una persona, el bot no le escribe al cliente y la secuencia termina', async () => {
  await conversacionRespondida('c-traspaso');
  await marcarTraspaso('c-traspaso', '5001', 'escalado');
  await correrPaso('c-traspaso');
  assert.equal(envios('c-traspaso').length, 0);
  assert.equal(omitido('c-traspaso'), 'traspaso_a_persona');
  assert.ok(sinNadaAgendado('c-traspaso'));
});

test('si el cliente responde, la secuencia vuelve a empezar desde el primero', async () => {
  await conversacionRespondida('c-rearma');
  await correrPaso('c-rearma');
  await correrPaso('c-rearma');
  assert.equal(plan('c-rearma').siguiente, 2);
  await conversacionRespondida('c-rearma'); // el bot respondió un mensaje nuevo del cliente
  assert.equal(plan('c-rearma').siguiente, 0);
});

test('al rearmar, lo que quedó agendado con la secuencia anterior de dos recordatorios se descarta', async () => {
  for (const cola of ['seguimiento:due', 'seguimiento:segundo:due']) {
    if (!zsets.has(cola)) zsets.set(cola, new Map());
    zsets.get(cola)!.set('c-migra', Date.now() + 3600_000);
  }
  await conversacionRespondida('c-migra');
  assert.ok(!zsets.get('seguimiento:due')!.has('c-migra'));
  assert.ok(!zsets.get('seguimiento:segundo:due')!.has('c-migra'));
});

test('un último recordatorio agendado antes del cambio se sigue enviando', async () => {
  kvStore.set('mem:c-viejo', JSON.stringify(CONVERSACION));
  if (!zsets.has('seguimiento:segundo:due')) zsets.set('seguimiento:segundo:due', new Map());
  zsets.get('seguimiento:segundo:due')!.set('c-viejo', Date.now() - 1000);
  await seg.barrerSegundosRecordatoriosVencidos();
  assert.equal(envios('c-viejo').length, 1);
  assert.ok(auditorias.some((a) => a.type === 'seguimiento' && a.dialogId === 'c-viejo' && a.detail.etapa === 2));
});

test('se distingue enviado de respondido: la respuesta del cliente a un recordatorio queda registrada una vez', async () => {
  await conversacionRespondida('c-respondido');
  await correrPaso('c-respondido');
  await seg.registrarRespuestaASeguimiento('c-respondido');
  await seg.registrarRespuestaASeguimiento('c-respondido');
  const r = auditorias.filter((a) => a.type === 'seguimiento_respondido' && a.dialogId === 'c-respondido');
  assert.equal(r.length, 1);
  assert.equal(r[0].detail.etapa, 1);
});

test('el recordatorio pasa por las mismas reglas que una respuesta: sin markdown ni enlaces sueltos', async () => {
  textoModelo = '**Hola de nuevo.** Revise el programa aquí: https://sitio-cualquiera.com/promo. Sigo por acá si quiere retomarlo.';
  try {
    await conversacionRespondida('c-guardian');
    await correrPaso('c-guardian');
    const msg = envios('c-guardian')[0].params.MESSAGE;
    assert.doesNotMatch(msg, /\*\*|sitio-cualquiera/);
    assert.match(msg, /Sigo por acá/);
  } finally {
    textoModelo = null;
  }
});

test('formatearTelefono: un celular chileno se escribe como se lee; los demás quedan igual', () => {
  assert.equal(seg.formatearTelefono('+56965862979'), '+56 9 6586 2979');
  assert.equal(seg.formatearTelefono('+51987298495'), '+51987298495');
});

// ── Revisión del 25-10 al 03-11-2026: lo que un recordatorio no puede decir ─────────────────────
test('problemasDelRecordatorio: lo que salió en una semana de recordatorios reales', () => {
  const p = seg.problemasDelRecordatorio;
  assert.match(p('¿Sigues interesado en la maestría? Puedes escribirme cuando quieras.').join(), /tutea/);
  assert.match(p('Veo que hizo clic en "Más información" pero no hemos recibido su respuesta.').join(), /Veo que/);
  assert.match(p('Entiendo que el cliente ya recibió información; aquí va el seguimiento: ¿le quedó alguna duda?').join(), /tercera persona/);
  assert.match(p('Ya revisé con el área académica y tengo la información lista para usted.').join(), /no está en la conversación/);
  assert.match(p('Le escribo porque llevo varios intentos de contacto sin respuesta de su parte.').join(), /reprocha/);
  assert.match(p('Quizá no es el momento; quedo atenta cuando quiera retomarlo.').join(), /género/);
  assert.deepEqual(p('¿Le cuento cuándo cierra la postulación del próximo ciclo?'), []);
  assert.deepEqual(p('El docente imparte las clases en vivo; ¿le acomoda el horario de la tarde?'), [], '"imparte" no es tuteo');
});

test('un recordatorio que sale mal se reescribe una vez, diciéndole al modelo qué corregir', async () => {
  cola.push('Veo que te interesó la maestría, ¿quieres que te cuente más?', '¿Le cuento cómo son las clases en vivo?');
  pedidos.length = 0;
  await conversacionRespondida('c-corrige');
  await correrPaso('c-corrige');
  assert.equal(envios('c-corrige')[0].params.MESSAGE, '¿Le cuento cómo son las clases en vivo?');
  const segundo = pedidos.at(-1)!;
  assert.equal(segundo.length, 3, 'el segundo pedido lleva el intento fallido y la corrección');
  assert.match(String(segundo[2].content), /Ese mensaje no sirve: .*tutea.*Veo que/);
});

test('si la segunda versión también sale mal, va un texto sencillo y seguro', async () => {
  cola.push('¿Tienes dudas del programa?', '¿Sigues con interés? Escríbeme.');
  await conversacionRespondida('c-seguro');
  await correrPaso('c-seguro');
  assert.equal(envios('c-seguro')[0].params.MESSAGE, seg.recordatorioSeguro('primero', 1));
  assert.deepEqual(seg.problemasDelRecordatorio(seg.recordatorioSeguro('primero', 1)), []);
  for (let etapa = 2; etapa <= 4; etapa++) assert.deepEqual(seg.problemasDelRecordatorio(seg.recordatorioSeguro('intermedio', etapa)), []);
  assert.deepEqual(seg.problemasDelRecordatorio(seg.recordatorioSeguro('cierre', 5)), []);
});

test('esRechazo: corta ante un no claro, no ante un "no" suelto ni un "no quiero perder la beca"', () => {
  assert.ok(seg.esRechazo('No me interesa, gracias'));
  assert.ok(seg.esRechazo('por ahora no, gracias'));
  assert.ok(seg.esRechazo('Ya me matriculé en otra universidad'));
  assert.ok(!seg.esRechazo('No'));
  assert.ok(!seg.esRechazo('no quiero perder la beca, ¿hasta cuándo es?'));
  assert.ok(!seg.esRechazo('Lo voy a pensar'));
  // La plantilla de cierre de admisión trae los tres botones, y el último es «Ya no estoy interesado/a».
  const SEP = '-'.repeat(54);
  const plantilla = 'Estamos cerrando el proceso de admisión. | [Quiero matricularme ahora] | [Quiero estudiar más adelante] | [Ya no estoy interesado/a]';
  assert.ok(!seg.esRechazo(`${SEP}\n${plantilla}\n${SEP}\nQuiero matricularme ahora`), 'el botón de la plantilla no cuenta');
  assert.ok(seg.esRechazo(`${SEP}\n${plantilla}\n${SEP}\nYa no estoy interesado/a`));
});

test('después de un "no me interesa", la secuencia no sigue', async () => {
  kvStore.set('mem:c-rechazo', JSON.stringify([...CONVERSACION, { role: 'user', content: 'No me interesa, gracias' }, { role: 'assistant', content: 'Entendido, gracias por avisarme.' }]));
  await seg.programarSeguimiento('c-rechazo', { deal: 1 }, '5001');
  await correrPaso('c-rechazo');
  assert.equal(envios('c-rechazo').length, 0);
  assert.equal(omitido('c-rechazo'), 'rechazo');
  assert.ok(sinNadaAgendado('c-rechazo'));
});

test('al reactivar una derivación que nadie tomó, la ventana corre desde el último mensaje y los pasos vencidos se saltan', async () => {
  const hace6h = Date.now() - 6 * 3600_000;
  await seg.programarSeguimiento('c-reactiva', { deal: 1 }, '5001', {
    clienteAt: hace6h,
    transcript: 'Cliente: Quiero la maestría en IA\nBot: Con la beca son USD 150 al mes. ¿Le reservo el cupo?',
  });
  const pasos: number[] = plan('c-reactiva').pasos;
  assert.equal(pasos.length, 3, 'de 3, 5, 7, 9 y 23 h quedan los que no pasaron: 7, 9 y 23 h');
  assert.ok(pasos.every((p) => p > Date.now()));
  assert.ok(pasos.at(-1)! - hace6h <= 23.5 * 3600_000, 'el último sigue dentro de la ventana de WhatsApp');
  const snap = JSON.parse(kvStore.get('seguimiento:snapshot:c-reactiva')!);
  assert.equal(snap.clienteAt, hace6h);
  assert.match(snap.transcript, /Le reservo el cupo/);
});
