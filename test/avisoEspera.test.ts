import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Avisos de cliente esperando (ai/avisoEspera.ts). Con una persona dentro del chat el bot no puede
// retomarlo —Bitrix rechaza traspasarle la sesión—, y el 05-11-2026 cuatro clientes de Carver llevaban
// más de 20 h sin respuesta. Los casos de abajo son esos chats.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.AVISO_ESPERA_HORAS = '2';
process.env.AVISO_ESPERA_ESCALAR_HORAS = '20';
process.env.BITRIX_SUPERVISOR_ID = '62741';
process.env.CONTROL_DIARIO_USUARIOS = '4173';
process.env.BITRIX_USUARIOS_AUTOMATICOS = '45';

const notificaciones: { USER_ID: number; MESSAGE: string }[] = [];
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: async (method: string, params: any) => {
      if (method === 'im.notify.personal.add') notificaciones.push(params);
      if (method === 'im.dialog.get') return { entity_id: 'ank_chats_app24_ca_whats_app|31|593996509609|822905' };
      return {};
    },
    callCrm: async () => ({}),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: [], total: 0, next: null }),
    callWebhook: async () => ({}),
  },
});

const reclamados = new Set<string>();
mock.module('../src/store/kv.ts', {
  namedExports: {
    getRedisClient: () => null,
    once: async (k: string) => {
      if (reclamados.has(k)) return false;
      reclamados.add(k);
      return true;
    },
    kvDel: async () => {},
    kvGet: async () => null,
    kvSet: async () => {},
    getJson: async () => null,
    getJsonOrThrow: async () => null,
    setJson: async () => {},
  },
});

let gestionada = false;
mock.module('../src/crm/embudos.ts', { namedExports: { derivacionYaGestionada: async () => gestionada } });
mock.module('../src/ai/seguimiento.ts', { namedExports: { entidadesDelSeguimiento: async () => ({ deal: 3716413 }) } });
const auditorias: any[] = [];
mock.module('../src/obs/audit.ts', { namedExports: { audit: async (e: any) => void auditorias.push(e) } });

const { textoDelCliente, esperaRespuesta, esperaDelCliente, avisosDebidos, textoDelAviso, avisarSiEspera } = await import('../src/ai/avisoEspera');

const H = 3600_000;
const ahora = Date.parse('2026-11-05T15:00:00Z'); // 12:00 en Chile
const estado = (o: Partial<any> = {}) => ({
  equipo: ['166867'],
  botDentro: true,
  clienteId: '822905',
  pendientes: [],
  pendientesConFecha: [],
  ultimoPendienteId: null,
  ultimaDelEquipo: 0,
  ultimaDelCliente: 0,
  ...o,
});
const pendiente = (texto: string, horas: number) => ({ texto, at: ahora - horas * H });

// ── ¿Pide respuesta? ──────────────────────────────────────────────────────────────────────────

test('textoDelCliente: de una plantilla, se queda con el botón que tocó', () => {
  const eco = '------------------------------------------------------\n"Hola, Pamela 👋\n\nEstamos cerrando el proceso de admisión... | [Quiero matricularme ahora] | [Ya no estoy interesado/a]\n------------------------------------------------------\nYa no estoy interesado/a';
  assert.equal(textoDelCliente(eco), 'Ya no estoy interesado/a');
  assert.equal(textoDelCliente('  Hola  '), 'Hola');
});

test('un agradecimiento, una despedida o un "no me interesa" no esperan respuesta', () => {
  for (const t of [
    'Gracias Claudio!!', // chat 1383805: ya estaba matriculada
    'Por el momento es todo gracias', // chat 1192249
    '---------------------------------\nplantilla | [Ya no estoy interesado/a]\n---------------------------------\nYa no estoy interesado/a', // chat 1562189
    'O sea no me interesa',
    'Perfecto, muchas gracias',
    'No gracias',
    '👍',
  ]) {
    assert.equal(esperaRespuesta(t), false, t);
  }
});

test('una pregunta, un pedido o un mensaje con contenido sí esperan respuesta', () => {
  for (const t of [
    'Hay que hacer convalidación?', // chat 1528637
    'Quería saber cuando empiezan las clases por favoe', // chat 1455451: sin signo de interrogación
    'Gracias por la informacion.tngo 49 años de edad jubilado en la policia nacional del ecuador. Creo que es muy complicado tener esa beca.', // chat 1572191
    'Gracias, cuando empiezan las clases',
    'No gracias, pero quiero info del MBA',
    'Si',
    'Buenas noches',
    '---------------------------------\nplantilla | [Más información]\n---------------------------------\nMás información',
  ]) {
    assert.equal(esperaRespuesta(t), true, t);
  }
});

// ── ¿Espera a una persona? ────────────────────────────────────────────────────────────────────

test('espera desde su primer mensaje que pide respuesta, aunque después agradezca', () => {
  const e = estado({ pendientesConFecha: [pendiente('Hay que hacer convalidación?', 5), pendiente('Gracias', 4.9)] });
  assert.deepEqual(esperaDelCliente(e as any, { at: ahora - 6 * H, motivo: 'operador' }), {
    desde: ahora - 5 * H,
    motivo: 'cliente_escribio',
    ultimoMensaje: 'Hay que hacer convalidación?',
  });
});

test('un chat bien atendido que termina en "gracias" no es una espera (chat 1383805)', () => {
  const e = estado({ ultimaDelEquipo: ahora - 3.1 * H, pendientesConFecha: [pendiente('Gracias Claudio!!', 3)] });
  assert.equal(esperaDelCliente(e as any, { at: ahora - 50 * H, motivo: 'operador' }), null);
});

test('una derivación del bot sin que nadie escriba después es una espera, aunque el cliente se despida (chat 1192249)', () => {
  // Pidió la resolución de SENESCYT, el bot prometió responder "hoy mismo", derivó y ella escribió
  // "Por el momento es todo gracias". Nadie del equipo le escribió.
  const e = estado({ equipo: ['62741'], ultimaDelCliente: ahora - 3 * H, pendientesConFecha: [pendiente('Por el momento es todo gracias', 3)] });
  const derivacion = { at: ahora - 3.1 * H, motivo: 'escalado' };
  assert.deepEqual(esperaDelCliente(e as any, derivacion), { desde: derivacion.at, motivo: 'derivacion_sin_tomar', ultimoMensaje: null });
  assert.equal(esperaDelCliente({ ...e, ultimaDelEquipo: ahora - 1 * H } as any, derivacion), null, 'alguien del equipo le escribió');
  assert.equal(esperaDelCliente(e as any, { ...derivacion, motivo: 'operador' }), null, 'la tomó un asesor por su cuenta');
});

// ── ¿Qué aviso toca? ──────────────────────────────────────────────────────────────────────────

test('a las 2 h avisa al equipo; a las 20 h del último mensaje, además escala; con la ventana cerrada, nada', () => {
  const horas = { primero: 2, escalar: 20 };
  const esp = (h: number) => ({ desde: ahora - h * H, motivo: 'cliente_escribio' as const, ultimoMensaje: 'x' });
  assert.deepEqual(avisosDebidos(esp(1.5), ahora - 1.5 * H, horas, ahora), []);
  assert.deepEqual(avisosDebidos(esp(2), ahora - 2 * H, horas, ahora), [1]);
  assert.deepEqual(avisosDebidos(esp(20), ahora - 20 * H, horas, ahora), [1, 2]);
  assert.deepEqual(avisosDebidos(esp(24), ahora - 24 * H, horas, ahora), []);
  assert.deepEqual(avisosDebidos(esp(20), ahora - 20 * H, { primero: 2, escalar: 0 }, ahora), [1], 'sin segundo aviso');
  assert.deepEqual(avisosDebidos(esp(20), 0, horas, ahora), [], 'sin mensajes del cliente no hay ventana que cuidar');
});

test('el aviso dice quién espera, qué escribió, quién está en el chat y hasta cuándo se le puede escribir', () => {
  const datos = {
    dominio: 'uachile.bitrix24.es',
    dialogId: 'chat1572191',
    cliente: 'Bayron',
    aCargo: ['Sigrid Rodriguez'],
    espera: { desde: ahora - 2 * H, motivo: 'cliente_escribio' as const, ultimoMensaje: 'Creo que es muy [URL=https://x.y]complicado[/URL] tener esa beca.' },
    ultimaDelCliente: ahora - 2 * H,
    whatsapp: true,
    ahora,
  };
  const t = textoDelAviso(1, datos);
  assert.match(t, /^\[B\]Cliente esperando respuesta hace 2 h\[\/B\]/);
  assert.match(t, /Bayron escribió en el chat y nadie le ha respondido: «Creo que es muy complicado tener esa beca\.»/);
  assert.match(t, /En el chat: Sigrid Rodriguez\./);
  assert.match(t, /hasta el viernes 6, 10:00 \(hora de Chile\)/, '24 h después de su último mensaje');
  assert.match(t, /\[URL=https:\/\/uachile\.bitrix24\.es\/online\/\?IM_DIALOG=chat1572191\]Abrir el chat\[\/URL\]/);
  assert.doesNotMatch(t, /x\.y/, 'lo que escribió el cliente no mete enlaces en la notificación');

  const escalado = textoDelAviso(2, { ...datos, espera: { ...datos.espera, desde: ahora - 20 * H }, ultimaDelCliente: ahora - 20 * H });
  assert.match(escalado, /^\[B\]Cliente sin respuesta hace 20 h: la ventana de WhatsApp cierra en 4 h\[\/B\]/);

  const derivado = textoDelAviso(1, { ...datos, cliente: null, whatsapp: false, espera: { desde: ahora - 2 * H, motivo: 'derivacion_sin_tomar', ultimoMensaje: null } });
  assert.match(derivado, /^\[B\]Chat derivado sin respuesta hace 2 h\[\/B\]/);
  assert.match(derivado, /nadie del equipo le ha escrito al cliente desde entonces/);
  assert.doesNotMatch(derivado, /WhatsApp/, 'fuera de WhatsApp no hay ventana de 24 h');
});

// ── Envío ─────────────────────────────────────────────────────────────────────────────────────

const AUTH = { domain: 'uachile.bitrix24.es', access_token: 'tok' } as any;
const base = (o: Partial<any> = {}) => ({
  dialogId: 'chat1572191',
  chatId: '1572191',
  estado: estado({
    equipo: ['166867', '45'],
    ultimaDelCliente: ahora - 2 * H,
    pendientesConFecha: [pendiente('Creo que es muy complicado tener esa beca.', 2)],
  }) as any,
  traspaso: { sesion: '1269471', at: ahora - 3 * H, motivo: 'operador' },
  participantes: [
    { id: 166867, name: 'Sigrid Rodriguez' },
    { id: 822905, name: 'Bao!!' },
  ],
  auth: AUTH,
  authAvisos: AUTH,
  ahora,
  ...o,
});
const reset = () => {
  notificaciones.length = 0;
  auditorias.length = 0;
  reclamados.clear();
  gestionada = false;
};

test('a las 2 h avisa a la persona del chat y a la supervisora, una sola vez', async () => {
  reset();
  assert.deepEqual(await avisarSiEspera(base()), [1]);
  assert.deepEqual(notificaciones.map((n) => n.USER_ID), [166867, 62741], 'el usuario automático (45) no recibe avisos');
  assert.match(notificaciones[0].MESSAGE, /Bao!! escribió en el chat/);
  assert.match(notificaciones[0].MESSAGE, /WhatsApp deja escribirle/);
  assert.equal(auditorias[0].type, 'aviso_cliente_esperando');

  assert.deepEqual(await avisarSiEspera(base({ ahora: ahora + 10 * 60_000 })), [], 'el barrido siguiente no lo repite');
  assert.equal(notificaciones.length, 2);
});

test('a las 20 h del último mensaje escala a quien recibe el control diario', async () => {
  reset();
  const e = estado({ equipo: ['166867'], ultimaDelCliente: ahora - 20 * H, pendientesConFecha: [pendiente('Hay que hacer convalidación?', 20)] });
  assert.deepEqual(await avisarSiEspera(base({ estado: e })), [1, 2]);
  assert.deepEqual(notificaciones.map((n) => n.USER_ID), [166867, 62741, 4173]);
  assert.match(notificaciones[2].MESSAGE, /la ventana de WhatsApp cierra en 4 h/);
});

test('no avisa si el cliente no espera, ni por una derivación que un asesor trabaja en el CRM', async () => {
  reset();
  const gracias = estado({ ultimaDelEquipo: ahora - 3.1 * H, ultimaDelCliente: ahora - 3 * H, pendientesConFecha: [pendiente('Gracias Claudio!!', 3)] });
  assert.deepEqual(await avisarSiEspera(base({ estado: gracias })), []);

  gestionada = true;
  const derivado = estado({ ultimaDelCliente: ahora - 3 * H, pendientesConFecha: [pendiente('Por el momento es todo gracias', 3)] });
  assert.deepEqual(await avisarSiEspera(base({ estado: derivado, traspaso: { sesion: '1', at: ahora - 3.1 * H, motivo: 'escalado' } })), []);
  assert.equal(notificaciones.length, 0);
});

test('en simulación dice qué avisos saldrían, sin mandar ni reclamar ninguno', async () => {
  reset();
  assert.deepEqual(await avisarSiEspera(base({ simular: true })), [1]);
  assert.equal(notificaciones.length, 0);
  assert.equal(reclamados.size, 0);
});
