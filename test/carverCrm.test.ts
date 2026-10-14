import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Integración con el CRM de Carver contra un Bitrix SIMULADO en memoria (auditoría oct-2026):
// identidad (hallazgo 1), derivación (7), equipo (9), estudiantes (10) y fee (5). Los IDs de
// departamentos y embudos son los reales verificados en el portal; los usuarios y fichas, sintéticos.
process.env.MARCA = 'carver';
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.BITRIX_DERIVAR_A = '1313';
process.env.BITRIX_EMBUDOS_PROPIOS = '73,135';
process.env.BITRIX_UF_PROGRAMA = 'UF_PROG';

type Llamada = { method: string; params: any };
const llamadas: Llamada[] = [];
const usuarios: Record<number, any> = {
  1313: { NAME: 'Punto', LAST_NAME: 'Entrada', EMAIL: 'entrada@carver.university', ACTIVE: true, UF_DEPARTMENT: [49] },
  479297: { NAME: 'Advisor', LAST_NAME: 'Uno', EMAIL: 'advisor.uno@carver.university', ACTIVE: true, UF_DEPARTMENT: [193] },
  // Advisor de licenciaturas en data/carver/advisors.json. El teléfono se mueve en las pruebas para
  // comprobar de dónde sale: la ficha de Bitrix manda sobre el número del archivo.
  479681: { NAME: 'Advisor', LAST_NAME: 'Dos', EMAIL: 'advisor.dos@carver.university', ACTIVE: true, UF_DEPARTMENT: [193] },
  685357: { NAME: 'Ejecutiva', LAST_NAME: 'Carver', EMAIL: 'ejecutiva@gmail.com', ACTIVE: true, UF_DEPARTMENT: [511] },
  9: { NAME: 'Ejecutivo', LAST_NAME: 'Postgrados', EMAIL: 'ejecutivo@uautonoma.cl', ACTIVE: true, UF_DEPARTMENT: [5] },
  45: { NAME: 'Resp.', LAST_NAME: 'Autom.', EMAIL: 'robot@uautonoma.cl', ACTIVE: true, UF_DEPARTMENT: [7] },
};
let deals: Record<number, any> = {};
let dealsPorContacto: Record<number, any[]> = {};
let crmCaido = false;

async function crm(method: string, params: any) {
  llamadas.push({ method, params });
  if (crmCaido) throw new Error('Bitrix no responde (simulado)');
  if (method === 'user.get') return [usuarios[params.ID]].filter(Boolean);
  if (method === 'crm.deal.get') return deals[params.id] ?? {};
  if (method === 'crm.deal.list') return dealsPorContacto[params.filter?.CONTACT_ID] ?? [];
  if (method === 'tasks.task.add') return { task: { id: 77 } };
  return {};
}
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: crm,
    callCrm: crm,
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: [], total: 0, next: null }),
    callWebhook: async () => ({}),
  },
});
const auditorias: any[] = [];
mock.module('../src/obs/audit.ts', { namedExports: { audit: async (e: any) => void auditorias.push(e) } });

const { getIdentidadAsesor } = await import('../src/crm/directory');
const { derivarAResponsableFijo } = await import('../src/crm/asignacionAsesores');
const { consultarEstadoEstudiante } = await import('../src/crm/estudiantes');
const { executeTool } = await import('../src/ai/toolRunner');
const { WHATSAPP_PROFILE } = await import('../src/core/channel');
const auth = { domain: 'test.bitrix24.com', access_token: 'tok' } as any;

function reset() {
  llamadas.length = 0;
  auditorias.length = 0;
  deals = {};
  dealsPorContacto = {};
  crmCaido = false;
}
const de = (m: string) => llamadas.filter((c) => c.method === m);

// ── Hallazgos 1 y 9: con qué nombre se presenta el bot ───────────────────────────────────────────
test('identidad: adopta al asesor de Carver de una negociación propia', async () => {
  reset();
  deals[9001] = { CATEGORY_ID: '135', ASSIGNED_BY_ID: '685357' };
  const id = await getIdentidadAsesor({ deal: 9001 }, auth);
  assert.equal(id?.nombre, 'Ejecutiva Carver');
});

test('identidad: NO se presenta como un ejecutivo de otro equipo (hallazgo 9)', async () => {
  reset();
  deals[9002] = { CATEGORY_ID: '135', ASSIGNED_BY_ID: '9' };
  assert.equal(await getIdentidadAsesor({ deal: 9002 }, auth), null);
});

test('identidad: NO adopta al responsable de una negociación de otro embudo', async () => {
  reset();
  deals[9003] = { CATEGORY_ID: '1', ASSIGNED_BY_ID: '685357' };
  assert.equal(await getIdentidadAsesor({ deal: 9003 }, auth), null);
});

test('identidad: NO se presenta como el robot "Resp. Autom."', async () => {
  reset();
  deals[9004] = { CATEGORY_ID: '73', ASSIGNED_BY_ID: '45' };
  assert.equal(await getIdentidadAsesor({ deal: 9004 }, auth), null);
});

// ── Hallazgos 7 y 9: a quién va la derivación ────────────────────────────────────────────────────
test('derivación: el asesor vigente de Carver conserva el lead y recibe la tarea', async () => {
  reset();
  deals[8001] = { CATEGORY_ID: '135', ASSIGNED_BY_ID: '685357', TITLE: 'Maestría en Psicología – Ana' };
  assert.equal(await derivarAResponsableFijo({ deal: 8001 }, auth), true);
  assert.equal(de('crm.deal.update').length, 0, 'no se le quita el lead');
  assert.equal(de('tasks.task.add')[0].params.fields.RESPONSIBLE_ID, 685357);
  assert.ok(auditorias.some((a) => a.type === 'derivacion' && a.detail.decision === 'tarea_al_asesor_vigente'));
});

test('derivación: un lead en manos de otro equipo pasa al punto de entrada, con constancia del anterior', async () => {
  reset();
  deals[8002] = { CATEGORY_ID: '135', ASSIGNED_BY_ID: '9', TITLE: 'Licenciatura en Psicología – Luis' };
  assert.equal(await derivarAResponsableFijo({ deal: 8002 }, auth), true);
  assert.equal(de('crm.deal.update')[0].params.fields.ASSIGNED_BY_ID, 1313);
  assert.equal(de('tasks.task.add')[0].params.fields.RESPONSIBLE_ID, 1313, 'la tarea NO va al ejecutivo ajeno');
  const nota = de('crm.timeline.comment.add')[0].params.fields.COMMENT;
  assert.match(nota, /Responsable anterior: usuario 9 \(no pertenece al equipo de esta marca\)/);
  assert.ok(auditorias.some((a) => a.type === 'derivacion' && a.detail.motivo === 'otro_equipo' && a.detail.antes === 9));
});

test('derivación: una negociación de otro embudo no se toca', async () => {
  reset();
  deals[8003] = { CATEGORY_ID: '1', ASSIGNED_BY_ID: '9' };
  assert.equal(await derivarAResponsableFijo({ deal: 8003 }, auth), false);
  assert.equal(de('crm.deal.update').length, 0);
  assert.equal(de('tasks.task.add').length, 0);
});

test('derivación: sin negociación en el chat, busca SOLO en los embudos propios del contacto', async () => {
  reset();
  await derivarAResponsableFijo({ contact: 555 }, auth);
  assert.deepEqual(de('crm.deal.list')[0].params.filter['@CATEGORY_ID'], [73, 135]);
});

// ── Hallazgo 10: estudiantes matriculados ────────────────────────────────────────────────────────
test('estudiante: con negociación de acompañamiento y Advisor verificada, entrega su correo institucional', async () => {
  reset();
  dealsPorContacto[700] = [{ ID: '6001', CATEGORY_ID: '107', STAGE_ID: 'C107:UC_7J3HFK', ASSIGNED_BY_ID: '479297', UF_PROG: 'Maestría en Psicología' }];
  const r: any = await consultarEstadoEstudiante({ contact: 700 }, auth);
  assert.equal(r.matriculado, true);
  assert.equal(r.advisor.email, 'advisor.uno@carver.university');
  assert.equal(r.programa, 'Maestría en Psicología');
  assert.deepEqual(de('crm.deal.list')[0].params.filter['@CATEGORY_ID'].sort(), [107, 135, 73].sort());
});

test('estudiante: si su responsable es el robot y no se sabe su programa, no se inventa una Advisor', async () => {
  reset();
  dealsPorContacto[701] = [{ ID: '6002', CATEGORY_ID: '107', STAGE_ID: 'C107:NEW', ASSIGNED_BY_ID: '45' }];
  const r: any = await consultarEstadoEstudiante({ contact: 701 }, auth);
  assert.equal(r.matriculado, true);
  assert.equal(r.advisor, null);
  assert.equal(r.motivoSinAdvisor, 'responsable_no_valido');
});

// ── Advisor según el tipo de programa ────────────────────────────────────────────────────────────
// En el embudo 107 el responsable casi nunca es una persona: de 1.030 negociaciones, 968 tienen
// Advisor y el resto quedó con el robot. Sin respaldo por tipo de programa, esos estudiantes
// recibían "no pude verificar quién te acompaña", que es cierto pero no les sirve de nada.
test('estudiante: con el robot a cargo, la Advisor sale del tipo de programa', async () => {
  reset();
  dealsPorContacto[710] = [{ ID: '6010', CATEGORY_ID: '107', STAGE_ID: 'C107:NEW', ASSIGNED_BY_ID: '45', UF_PROG: 'Maestría en Inteligencia Artificial' }];
  const maestria: any = await consultarEstadoEstudiante({ contact: 710 }, auth);
  assert.equal(maestria.advisor.id, 479297, 'las maestrías van a la Advisor de maestrías');

  dealsPorContacto[711] = [{ ID: '6011', CATEGORY_ID: '107', STAGE_ID: 'C107:NEW', ASSIGNED_BY_ID: '45', UF_PROG: 'Licenciatura en Psicología' }];
  const licenciatura: any = await consultarEstadoEstudiante({ contact: 711 }, auth);
  assert.equal(licenciatura.advisor.id, 479681, 'las licenciaturas van a la otra');

  // Los nombres en inglés son los mismos programas: "Bachelor of Science in Psychology".
  dealsPorContacto[712] = [{ ID: '6012', CATEGORY_ID: '107', STAGE_ID: 'C107:NEW', ASSIGNED_BY_ID: '45', UF_PROG: 'Bachelor of Science in Psychology' }];
  assert.equal(((await consultarEstadoEstudiante({ contact: 712 }, auth)) as any).advisor.id, 479681);
});

test('estudiante: la Advisor REAL del caso le gana a la tabla por tipo de programa', async () => {
  // La tabla es un respaldo, no una regla: si alguien asignó a mano a otra Advisor, manda esa.
  reset();
  dealsPorContacto[713] = [{ ID: '6013', CATEGORY_ID: '107', STAGE_ID: 'C107:NEW', ASSIGNED_BY_ID: '479297', UF_PROG: 'Licenciatura en Psicología' }];
  const r: any = await consultarEstadoEstudiante({ contact: 713 }, auth);
  assert.equal(r.advisor.id, 479297, 'la responsable de la negociación, aunque sea una licenciatura');
});

test('estudiante: un programa sin Advisor asignada no se adivina', async () => {
  // Los cursos de educación continua y los diplomados no tienen Advisor en el embudo 107. Mandar al
  // estudiante con alguien que no lo acompaña es peor que decirle el canal oficial.
  reset();
  dealsPorContacto[714] = [{ ID: '6014', CATEGORY_ID: '107', STAGE_ID: 'C107:NEW', ASSIGNED_BY_ID: '45', UF_PROG: 'Curso de Educación Continua en Hacking Ético' }];
  const r: any = await consultarEstadoEstudiante({ contact: 714 }, auth);
  assert.equal(r.advisor, null);
  assert.equal(r.motivoSinAdvisor, 'programa_sin_advisor');
});

test('estudiante: una Advisor de la tabla que ya no está activa no se entrega', async () => {
  // El archivo dice QUIÉN; Bitrix dice SI TODAVÍA. Si alguien se va de Carver, su nombre deja de
  // salir sin que haya que acordarse de editar el archivo.
  reset();
  usuarios[479681].ACTIVE = false;
  dealsPorContacto[715] = [{ ID: '6015', CATEGORY_ID: '107', STAGE_ID: 'C107:NEW', ASSIGNED_BY_ID: '45', UF_PROG: 'Licenciatura en Ingeniería Informática' }];
  const r: any = await consultarEstadoEstudiante({ contact: 715 }, auth);
  usuarios[479681].ACTIVE = true;
  assert.equal(r.advisor, null);
  assert.match(r.motivoSinAdvisor, /^advisor_de_tabla_/);
});

test('estudiante: el telefono es el institucional de las Advisor, nunca su movil personal', async () => {
  // Correccion de la direccion: hay UN numero por el que se escribe a las Advisor. El movil que
  // algunas tienen cargado en Bitrix es un dato del empleado, no un canal de atencion: repartirlo a
  // los estudiantes es dar el celular de alguien que no dio permiso.
  reset();
  usuarios[479681].PERSONAL_MOBILE = '+51900846196';
  dealsPorContacto[716] = [{ ID: '6016', CATEGORY_ID: '107', STAGE_ID: 'C107:NEW', ASSIGNED_BY_ID: '45', UF_PROG: 'Licenciatura en Psicologia' }];
  const r: any = await consultarEstadoEstudiante({ contact: 716 }, auth);
  delete usuarios[479681].PERSONAL_MOBILE;
  assert.equal(r.advisor.telefono, '+14073165413');
  assert.notEqual(r.advisor.telefono, '+51900846196', 'el movil personal de Bitrix no se entrega');
});

test('estudiante: la Advisor real del caso tambien entrega el telefono institucional', async () => {
  reset();
  usuarios[479297].PERSONAL_MOBILE = '+56911112222';
  dealsPorContacto[717] = [{ ID: '6017', CATEGORY_ID: '107', STAGE_ID: 'C107:NEW', ASSIGNED_BY_ID: '479297', UF_PROG: 'Maestria en Psicologia' }];
  const r: any = await consultarEstadoEstudiante({ contact: 717 }, auth);
  delete usuarios[479297].PERSONAL_MOBILE;
  assert.equal(r.advisor.telefono, '+14073165413');
  assert.equal(r.advisor.email, 'advisor.uno@carver.university');
});

test('advisors.json: correos institucionales y UN telefono en formato internacional', async () => {
  const { readFileSync } = await import('node:fs');
  const j = JSON.parse(readFileSync(new URL('../data/carver/advisors.json', import.meta.url), 'utf8'));
  assert.ok(j.advisors.length >= 2);
  assert.match(j.telefonoAdvisors, /^\+[1-9]\d{7,14}$/, 'el telefono de las Advisor, en formato internacional');
  for (const a of j.advisors) {
    assert.ok(Number.isInteger(a.userId) && a.userId > 0, `${a.nombre} sin userId`);
    assert.match(a.email, /@carver\.university$/, `${a.nombre} con correo no institucional`);
    assert.ok(a.tipos.length, `${a.nombre} sin tipos de programa`);
    // Un numero por Advisor volveria a abrir la puerta a cargar ahi un movil personal.
    assert.equal(a.telefono, undefined, `${a.nombre} no debe tener telefono propio`);
  }
});

test('estudiante: un correo que no es institucional no se entrega', async () => {
  reset();
  dealsPorContacto[702] = [{ ID: '6003', CATEGORY_ID: '107', STAGE_ID: 'C107:NEW', ASSIGNED_BY_ID: '685357' }];
  const r: any = await consultarEstadoEstudiante({ contact: 702 }, auth);
  assert.equal(r.advisor, null);
  assert.equal(r.motivoSinAdvisor, 'correo_no_institucional');
});

test('estudiante: matriculado por etapa ganada, aunque todavía no tenga negociación de acompañamiento', async () => {
  reset();
  dealsPorContacto[703] = [{ ID: '6004', CATEGORY_ID: '73', STAGE_ID: 'C73:WON', ASSIGNED_BY_ID: '685357' }];
  const r: any = await consultarEstadoEstudiante({ contact: 703 }, auth);
  assert.equal(r.matriculado, true);
  assert.equal(r.advisor, null);
});

test('estudiante: sin fichas de estudiante → no matriculado; retirado → no matriculado', async () => {
  reset();
  assert.equal(((await consultarEstadoEstudiante({ contact: 704 }, auth)) as any).matriculado, false);
  dealsPorContacto[705] = [{ ID: '6005', CATEGORY_ID: '107', STAGE_ID: 'C107:LOSE', ASSIGNED_BY_ID: '479297' }];
  assert.equal(((await consultarEstadoEstudiante({ contact: 705 }, auth)) as any).matriculado, false);
});

test('estudiante: sin contacto no se presume nada; con Bitrix caído se informa el error', async () => {
  reset();
  assert.equal(((await consultarEstadoEstudiante({}, auth)) as any).motivo, 'sin_contacto_para_verificar');
  crmCaido = true;
  assert.deepEqual(await consultarEstadoEstudiante({ contact: 706 }, auth), { ok: false, error: 'CRM_NO_DISPONIBLE' });
});

// ── Herramientas de punta a punta ────────────────────────────────────────────────────────────────
const ctx = (extra: any = {}) => ({
  profile: WHATSAPP_PROFILE,
  auth,
  conversationId: `chat-${Math.random().toString(36).slice(2)}`,
  crmEntities: {},
  chatId: '123',
  ...extra,
});

test('herramienta de precio: el fee viaja SOLO si el cliente lo preguntó (hallazgo 5)', async () => {
  reset();
  const sinPregunta: any = await executeTool('consultar_condiciones_comerciales', { programa: 'Maestría en Salud Mental' }, ctx({ ultimoMensajeCliente: '¿Cuánto cuesta?' }) as any);
  assert.equal(sinPregunta.costosAdicionales, undefined);
  const conPregunta: any = await executeTool(
    'consultar_condiciones_comerciales',
    { programa: 'Maestría en Salud Mental' },
    ctx({ ultimoMensajeCliente: '¿Hay que pagar algo por la titulación?' }) as any,
  );
  assert.equal(conPregunta.costosAdicionales.titulacionUsd, 125);
});

test('escalar_a_humano: el bot que habla como el asesor no se nombra en tercera persona', async () => {
  reset();
  deals[8100] = { CATEGORY_ID: '135', ASSIGNED_BY_ID: '685357', TITLE: 'x' };
  const r: any = await executeTool(
    'escalar_a_humano',
    { motivo: 'quiere avanzar' },
    ctx({ crmEntities: { deal: 8100 }, identidadAsesor: { nombre: 'Ejecutiva Carver' }, sesionOpenLines: '42' }) as any,
  );
  assert.equal(r.asesor, null);
  assert.match(r.mensaje, /primera persona/);
});

test('soporte a estudiante: la derivación va a SU Advisor, sin tocar la negociación comercial ni silenciar al bot', async () => {
  reset();
  dealsPorContacto[710] = [{ ID: '6010', CATEGORY_ID: '107', STAGE_ID: 'C107:PREPAYMENT_INVOI', ASSIGNED_BY_ID: '479297' }];
  const c = ctx({ crmEntities: { contact: 710, deal: 8200 } });
  const estado: any = await executeTool('consultar_estado_estudiante', {}, c as any);
  assert.equal(estado.advisor.email, 'advisor.uno@carver.university');
  assert.match(estado.nota, /NO le ofrezcas programas/);
  const r: any = await executeTool('escalar_a_humano', { motivo: 'no puede entrar a la plataforma', tipo: 'soporte_estudiante' }, c as any);
  assert.equal(r.tipo, 'soporte_estudiante');
  assert.equal(de('tasks.task.add')[0].params.fields.RESPONSIBLE_ID, 479297);
  assert.deepEqual(de('tasks.task.add')[0].params.fields.UF_CRM_TASK, ['D_6010'], 'la tarea cuelga de la ficha de acompañamiento');
  assert.equal(de('crm.deal.update').length, 0, 'no reasigna nada');
  assert.notEqual((c as any).transferirAOperador, true, 'no entrega la sesión a la cola de ventas');
});

test('herramienta de brochure: un NOOC devuelve ok=false sin enlace', async () => {
  reset();
  const r: any = await executeTool('obtener_brochure', { programa: 'Hacking ético' }, ctx() as any);
  assert.equal(r.ok, false);
  assert.equal(r.url, undefined);
  assert.ok(auditorias.some((a) => a.type === 'brochure' && a.detail.motivo === 'programa_no_comercializable'));
});

test('información institucional: toda consulta queda auditada, se tenga o no el dato', async () => {
  // Esta prueba afirmaba que el calendario NO estaba disponible. Era una foto del dato —el tema
  // estaba pendiente— y quedó en rojo al cargarlo con el documento de la dirección. Lo que debe
  // sostenerse es que la consulta se audite siempre: así se ve qué preguntan y qué falta responder.
  reset();
  const r: any = await executeTool('consultar_informacion_institucional', { tema: 'calendario_ingresos' }, ctx() as any);
  assert.equal(r.ok, true);
  const a = auditorias.find((x) => x.type === 'conocimiento' && x.detail.tema === 'calendario_ingresos');
  assert.ok(a, 'la consulta debe quedar auditada');
  assert.equal(a.detail.disponible, r.disponible, 'la auditoría registra si se pudo responder');
});

test('información institucional: un tema sin cargar devuelve la instrucción de no inventar', async () => {
  reset();
  const r: any = await executeTool('consultar_informacion_institucional', { tema: 'enlace_postulacion' }, ctx() as any);
  assert.equal(r.disponible, false);
  assert.match(r.instruccion, /NO lo inventes/);
});
