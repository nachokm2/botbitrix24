import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Panel de configuración: quién entra (usuario de Bitrix + lista de editores) y cómo se publica.
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';
process.env.BITRIX_PORTAL_DOMAIN = 'uachile.bitrix24.es';
process.env.PANEL_EDITORES = '4173, 307929';
process.env.PANEL_SECRETO = 'x'.repeat(40);

const llamadasBitrix: Array<{ method: string; auth: any }> = [];
let respuestaUsuario: () => any = () => ({ ID: '4173', NAME: 'Rodrigo', LAST_NAME: 'Palma' });
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: async (method: string, _params: any, auth: any) => {
      llamadasBitrix.push({ method, auth });
      return respuestaUsuario();
    },
    callCrm: async () => ({}),
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: {}, total: 0 }),
    callWebhook: async () => ({}),
  },
});

// Base en memoria con el mismo contrato que store/db.ts.
type V = { id: number; seccion: string; estado: string; contenido: any; autorId: number; autorNombre: string; nota: string | null; creadaEn: string; publicadaEn: string | null; publicadaPorId: number | null; publicadaPor: string | null };
let filas: V[] = [];
let siguienteId = 1;
const auditorias: any[] = [];
mock.module('../src/store/db.ts', {
  namedExports: {
    dbConfigPublicadas: async () => filas.filter((f) => f.estado === 'publicada').map((f) => ({ seccion: f.seccion, contenido: f.contenido })),
    dbConfigSeccion: async (s: string) => ({
      publicada: filas.find((f) => f.seccion === s && f.estado === 'publicada') ?? null,
      borrador: filas.find((f) => f.seccion === s && f.estado === 'borrador') ?? null,
      historial: filas.filter((f) => f.seccion === s && f.estado !== 'borrador').reverse(),
    }),
    dbConfigVersion: async (s: string, id: number) => filas.find((f) => f.id === id && f.seccion === s && f.estado !== 'borrador') ?? null,
    dbConfigGuardarBorrador: async (s: string, contenido: any, autor: any, previo: number | null) => {
      const actual = filas.find((f) => f.seccion === s && f.estado === 'borrador');
      if ((actual?.id ?? null) !== previo) return { ok: false, motivo: 'conflicto' };
      filas = filas.filter((f) => f !== actual);
      const v: V = { id: siguienteId++, seccion: s, estado: 'borrador', contenido, autorId: autor.id, autorNombre: autor.nombre, nota: null, creadaEn: new Date().toISOString(), publicadaEn: null, publicadaPorId: null, publicadaPor: null };
      filas.push(v);
      return { ok: true, version: v };
    },
    dbConfigDescartarBorrador: async () => ({ ok: false, motivo: 'conflicto' }),
    dbConfigPublicar: async (s: string, id: number, nota: string, quien: any) => {
      const b = filas.find((f) => f.seccion === s && f.estado === 'borrador');
      if (!b) return { ok: false, motivo: 'sin_borrador' };
      if (b.id !== id) return { ok: false, motivo: 'conflicto' };
      for (const f of filas) if (f.seccion === s && f.estado === 'publicada') f.estado = 'archivada';
      Object.assign(b, { estado: 'publicada', publicadaEn: new Date().toISOString(), publicadaPorId: quien.id, publicadaPor: quien.nombre, nota });
      return { ok: true, version: b };
    },
    dbInsertAudit: async (e: any) => void auditorias.push(e),
  },
});

const { panelPagina, panelGuardarBorrador, panelPublicar } = await import('../src/routes/panelConfig');
const { firmarSesion, verificarSesion, requirePanelSesion, DURACION_SESION_MS } = await import('../src/routes/panelSesion');
const { horarios, horariosPorDefecto, _fijarPublicadaParaPruebas } = await import('../src/core/ajustes');

function respuesta() {
  const r: any = { statusCode: 200, headers: {} as Record<string, string>, locals: {}, cuerpo: undefined };
  r.status = (c: number) => ((r.statusCode = c), r);
  r.json = (b: any) => ((r.cuerpo = b), r);
  r.send = (b: any) => ((r.cuerpo = b), r);
  r.set = (k: string, v: string) => ((r.headers[k.toLowerCase()] = v), r);
  return r;
}
const pedido = (p: { body?: any; query?: any; params?: any; headers?: Record<string, string> } = {}) =>
  ({ body: p.body ?? {}, query: p.query ?? {}, params: p.params ?? {}, header: (n: string) => p.headers?.[n.toLowerCase()] }) as any;
const desdeBitrix = (dominio = 'uachile.bitrix24.es') => pedido({ body: { AUTH_ID: 'tok-usuario', REFRESH_ID: 'ref-usuario' }, query: { DOMAIN: dominio } });

const contenido = () => ({ ...horariosPorDefecto(), asesoresActivo: true, asesoresDias: [1, 2, 3, 4, 5], asesoresInicio: '09:00', asesoresFin: '18:30', feriados: [], ritmoMinS: 1, ritmoMaxS: 20, automaticosHoraInicio: 9, automaticosHoraFin: 21 });

// ── Ingreso ────────────────────────────────────────────────────────────────────────────────────

test('panel: un portal ajeno se rechaza ANTES de llamar a Bitrix', async () => {
  llamadasBitrix.length = 0;
  const res = respuesta();
  await panelPagina(desdeBitrix('portal-ajeno.bitrix24.com'), res);
  assert.equal(res.statusCode, 403);
  assert.equal(llamadasBitrix.length, 0, 'con un portal ajeno, user.current respondería lo que el atacante quisiera');
});

test('panel: sin el token que entrega Bitrix no se entra', async () => {
  const res = respuesta();
  await panelPagina(pedido({ query: { DOMAIN: 'uachile.bitrix24.es' } }), res);
  assert.equal(res.statusCode, 401);
  assert.match(res.cuerpo, /desde Bitrix24/);
});

test('panel: se verifica al usuario SIN refresh_token, para que su token nunca reemplace al del bot', async () => {
  llamadasBitrix.length = 0;
  respuestaUsuario = () => ({ ID: '4173', NAME: 'Rodrigo', LAST_NAME: 'Palma' });
  const res = respuesta();
  await panelPagina(desdeBitrix(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(llamadasBitrix.map((l) => l.method), ['user.current']);
  assert.deepEqual(llamadasBitrix[0].auth, { domain: 'uachile.bitrix24.es', access_token: 'tok-usuario' });
  assert.equal(res.headers['cache-control'], 'no-store');
  const sesion = /name="panel-sesion" content="([^"]+)"/.exec(res.cuerpo)?.[1] ?? '';
  assert.deepEqual(verificarSesion(sesion), { id: 4173, nombre: 'Rodrigo Palma' });
  assert.match(res.cuerpo, /Rodrigo Palma/);
});

test('panel: quien no está en la lista de editores no entra, y se le dice por qué', async () => {
  respuestaUsuario = () => ({ ID: '62741', NAME: 'Danna', LAST_NAME: 'Verdugo' });
  const res = respuesta();
  await panelPagina(desdeBitrix(), res);
  assert.equal(res.statusCode, 403);
  assert.match(res.cuerpo, /Danna Verdugo, tu usuario no está habilitado/);
});

test('panel: un usuario sin acceso a la app en Bitrix recibe instrucciones, no un error técnico', async () => {
  respuestaUsuario = () => {
    throw new Error('Bitrix user.current: user_access_error The user does not have access to the application');
  };
  const res = respuesta();
  await panelPagina(desdeBitrix(), res);
  assert.equal(res.statusCode, 403);
  assert.match(res.cuerpo, /no tiene acceso a la aplicación del bot/);
  respuestaUsuario = () => ({ ID: '4173', NAME: 'Rodrigo', LAST_NAME: 'Palma' });
});

test('panel: el nombre que viene de Bitrix se escapa al ponerlo en la página', async () => {
  respuestaUsuario = () => ({ ID: '307929', NAME: '<img src=x onerror=alert(1)>', LAST_NAME: 'Rojas' });
  const res = respuesta();
  await panelPagina(desdeBitrix(), res);
  assert.equal(res.statusCode, 200);
  assert.doesNotMatch(res.cuerpo, /<img src=x/);
  respuestaUsuario = () => ({ ID: '4173', NAME: 'Rodrigo', LAST_NAME: 'Palma' });
});

// ── Sesión ─────────────────────────────────────────────────────────────────────────────────────

test('sesión: firmada, con vencimiento, y se corta al sacar a alguien de la lista', () => {
  const t = firmarSesion({ id: 307929, nombre: 'Franco Rojas' }, 1_000)!;
  assert.deepEqual(verificarSesion(t, 2_000), { id: 307929, nombre: 'Franco Rojas' });
  assert.equal(verificarSesion(t, 1_000 + DURACION_SESION_MS + 1), null, 'vencida');
  const [cuerpo, firma] = t.split('.');
  const otroCuerpo = Buffer.from(JSON.stringify({ uid: 4173, nombre: 'x', exp: 9e15 })).toString('base64url');
  assert.equal(verificarSesion(`${otroCuerpo}.${firma}`, 2_000), null, 'no se puede cambiar el usuario sin la clave');
  assert.equal(verificarSesion(`${cuerpo}.${firma}x`, 2_000), null);
  const antes = process.env.PANEL_EDITORES;
  process.env.PANEL_EDITORES = '4173';
  assert.equal(verificarSesion(t, 2_000), null, 'quitarlo de la lista le corta el acceso en el acto');
  process.env.PANEL_EDITORES = antes;
});

test('sesión: la API exige la credencial, y sin editores configurados el panel no existe', () => {
  const sinToken = respuesta();
  let paso = false;
  requirePanelSesion(pedido(), sinToken, () => (paso = true));
  assert.equal(sinToken.statusCode, 401);
  assert.equal(paso, false);

  const ok = respuesta();
  requirePanelSesion(pedido({ headers: { authorization: `Bearer ${firmarSesion({ id: 4173, nombre: 'Rodrigo Palma' })}` } }), ok, () => (paso = true));
  assert.equal(paso, true);
  assert.equal(ok.locals.editor.id, 4173);

  const antes = process.env.PANEL_EDITORES;
  process.env.PANEL_EDITORES = '';
  const apagado = respuesta();
  requirePanelSesion(pedido(), apagado, () => {});
  assert.equal(apagado.statusCode, 404, 'en Postgrados, sin PANEL_EDITORES, el panel no existe');
  process.env.PANEL_EDITORES = antes;
});

// ── Borrador y publicación ─────────────────────────────────────────────────────────────────────

const comoEditor = (p: Parameters<typeof pedido>[0]) => {
  const res = respuesta();
  res.locals.editor = { id: 4173, nombre: 'Rodrigo Palma' };
  return { req: pedido({ ...p, params: { seccion: 'horarios', ...(p?.params ?? {}) } }), res };
};

test('borrador: con datos inválidos no se guarda y se devuelven los campos a corregir', async () => {
  filas = [];
  const { req, res } = comoEditor({ body: { contenido: { ...contenido(), asesoresFin: '08:00' }, borradorId: null } });
  await panelGuardarBorrador(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.cuerpo.errores[0].campo, 'asesoresFin');
  assert.equal(filas.length, 0);
});

test('borrador → publicar: el bot lo toma en el acto, queda auditado, y nada cambia antes de publicar', async () => {
  filas = [];
  _fijarPublicadaParaPruebas('horarios', null);
  const nuevo = { ...contenido(), feriados: [{ fecha: '2026-12-25', nombre: 'Navidad' }] };
  const g = comoEditor({ body: { contenido: nuevo, borradorId: null } });
  await panelGuardarBorrador(g.req, g.res);
  assert.equal(g.res.statusCode, 200);
  assert.equal(horarios().feriados.length, 0, 'un borrador no rige');

  // Otra persona guarda encima de un borrador viejo: conflicto, no se pisa en silencio.
  const pisa = comoEditor({ body: { contenido: nuevo, borradorId: null } });
  await panelGuardarBorrador(pisa.req, pisa.res);
  assert.equal(pisa.res.statusCode, 409);

  const borradorId = g.res.cuerpo.borrador.id;
  const p = comoEditor({ body: { borradorId, nota: 'Agrego Navidad' } });
  await panelPublicar(p.req, p.res);
  assert.equal(p.res.statusCode, 200);
  assert.deepEqual(horarios().feriados, [{ fecha: '2026-12-25', nombre: 'Navidad' }]);
  assert.equal(p.res.cuerpo.publicada.publicadaPor, 'Rodrigo Palma');
  assert.ok(auditorias.some((a) => a.type === 'config_publicada' && a.detail.nota === 'Agrego Navidad'));
  _fijarPublicadaParaPruebas('horarios', null);
});

test('publicar: se valida lo guardado, no lo que diga la página', async () => {
  filas = [{ id: 99, seccion: 'horarios', estado: 'borrador', contenido: { ...contenido(), ritmoMaxS: 500 }, autorId: 4173, autorNombre: 'Rodrigo Palma', nota: null, creadaEn: new Date().toISOString(), publicadaEn: null, publicadaPorId: null, publicadaPor: null }];
  const p = comoEditor({ body: { borradorId: 99 } });
  await panelPublicar(p.req, p.res);
  assert.equal(p.res.statusCode, 400);
  assert.equal(filas[0].estado, 'borrador', 'no se publicó');
});
