import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Request, Response } from 'express';
import { config } from '../config';
import { marca } from '../marca';
import { log } from '../log';
import { callBitrix } from '../bitrix/client';
import { SECCIONES, esSeccion, refrescarAjustes, vigente, type NombreSeccion, type Horarios } from '../core/ajustes';
import { vistaSemanal } from '../core/horarioAsesores';
import {
  dbConfigPublicadas,
  dbConfigSeccion,
  dbConfigVersion,
  dbConfigGuardarBorrador,
  dbConfigDescartarBorrador,
  dbConfigPublicar,
  dbInsertAudit,
  type ResultadoConfig,
} from '../store/db';
import { editoresPanel, esEditor, firmarSesion, type Editor } from './panelSesion';
import { escaparHtml } from '../util/html';

/**
 * Panel de configuración del bot: lo abren dentro de Bitrix24 personas que no programan, para cambiar
 * el comportamiento del bot sin pasar por código ni por Railway. Qué se edita está en core/ajustes.ts;
 * acá está quién puede y cómo: entrar con su usuario de Bitrix, editar un borrador, probarlo y
 * publicarlo, con historial.
 */

const PANEL_HTML = readFileSync(fileURLToPath(new URL('../../public/panel/index.html', import.meta.url)), 'utf8');
const VERSION_ASSETS = String(Date.now());

function paginaAviso(mensaje: string): string {
  return (
    `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Configuración del bot</title>` +
    `<body style="font-family:system-ui,sans-serif;max-width:560px;margin:3rem auto;padding:0 1rem;color:#1f2937;line-height:1.5">` +
    `<h1 style="font-size:1.25rem">Configuración del bot</h1><p>${escaparHtml(mensaje)}</p></body></html>`
  );
}

/**
 * La página. Bitrix24 la abre por POST con el token del usuario que hizo clic (AUTH_ID) y el portal en
 * ?DOMAIN=. Se valida el portal ANTES de llamar a nada: si no, alguien podría mandar su propio portal y
 * un token suyo, y user.current respondería lo que él quisiera.
 */
export async function panelPagina(req: Request, res: Response) {
  if (!editoresPanel().length) return res.status(404).send(paginaAviso('No encontrado.'));
  const cuerpo: any = req.body ?? {};
  const token = typeof cuerpo.AUTH_ID === 'string' ? cuerpo.AUTH_ID : '';
  const dominioCrudo = req.query.DOMAIN ?? cuerpo.DOMAIN;
  const dominio = typeof dominioCrudo === 'string' ? dominioCrudo.trim().toLowerCase() : '';

  if (!token) {
    return res.status(401).send(paginaAviso('Abre este panel desde Bitrix24: es ahí donde se verifica quién eres.'));
  }
  if (!config.bitrixPortalDomain || dominio !== config.bitrixPortalDomain) {
    log.warn('panel: portal no autorizado', { dominio });
    return res.status(403).send(paginaAviso('Portal no autorizado.'));
  }

  let usuario: any;
  try {
    // Sin refresh_token a propósito: si el token del usuario venciera, callBitrix lo renovaría y lo
    // GUARDARÍA como el token del app, y el bot quedaría operando con las credenciales de quien abrió
    // el panel. Un token vencido acá solo significa "vuelve a abrir la pestaña".
    usuario = await callBitrix('user.current', {}, { domain: dominio, access_token: token });
  } catch (e) {
    const err = String(e);
    log.warn('panel: no se pudo verificar al usuario con Bitrix', { err: err.slice(0, 200) });
    if (/user_access_error/.test(err)) {
      return res.status(403).send(
        paginaAviso('Tu usuario no tiene acceso a la aplicación del bot en Bitrix24. Pide a un administrador del portal que te lo habilite.'),
      );
    }
    if (/expired_token|invalid_token/.test(err)) {
      return res.status(401).send(paginaAviso('Tu sesión de Bitrix24 venció. Cierra y vuelve a abrir esta pestaña.'));
    }
    return res.status(502).send(paginaAviso('No pudimos verificar tu usuario con Bitrix24. Intenta de nuevo en unos minutos.'));
  }

  const id = Number(usuario?.ID);
  const nombre = `${usuario?.NAME ?? ''} ${usuario?.LAST_NAME ?? ''}`.trim() || `Usuario ${id}`;
  if (!esEditor(id)) {
    log.info('panel: usuario sin permiso de edición', { id });
    return res.status(403).send(
      paginaAviso(`${nombre}, tu usuario no está habilitado para editar la configuración del bot. Si lo necesitas, pídele acceso a quien administra el bot.`),
    );
  }
  const sesion = firmarSesion({ id, nombre });
  if (!sesion) {
    log.error('panel: sin clave para firmar sesiones (PANEL_SECRETO, TOKEN_ENC_KEY o ADMIN_TOKEN)');
    return res.status(503).send(paginaAviso('El panel no está configurado todavía. Avísale a quien administra el bot.'));
  }

  log.info('panel: ingreso', { id });
  const html = PANEL_HTML.replaceAll('{{SESION}}', escaparHtml(sesion))
    .replaceAll('{{EDITOR}}', escaparHtml(nombre))
    .replaceAll('{{ORGANIZACION}}', escaparHtml(marca.etiquetaPanel))
    .replaceAll('{{V}}', VERSION_ASSETS);
  res.set('Content-Type', 'text/html; charset=utf-8');
  // Que nadie cachee una página que lleva una credencial adentro.
  res.set('Cache-Control', 'no-store');
  return res.send(html);
}

const MENSAJES: Record<Exclude<ResultadoConfig, { ok: true }>['motivo'], [number, string]> = {
  sin_db: [503, 'La base de datos no está disponible en este momento. Intenta de nuevo en unos minutos; el bot sigue funcionando con la configuración publicada.'],
  conflicto: [409, 'Otra persona cambió esta sección mientras la editabas. Recarga para ver la última versión antes de seguir.'],
  sin_borrador: [409, 'No hay un borrador para publicar. Guarda tus cambios primero.'],
  no_existe: [404, 'Esa versión no existe.'],
};

function responderFallo(res: Response, r: Exclude<ResultadoConfig, { ok: true }>) {
  const [status, error] = MENSAJES[r.motivo];
  return res.status(status).json({ ok: false, motivo: r.motivo, error });
}

function seccionDe(req: Request, res: Response): NombreSeccion | null {
  const s = req.params.seccion;
  if (esSeccion(s)) return s;
  res.status(404).json({ ok: false, error: 'Esa sección no existe.' });
  return null;
}

const idDe = (x: unknown): number | null => {
  const n = Number(x);
  return Number.isInteger(n) && n > 0 ? n : null;
};

async function estadoSeccion(seccion: NombreSeccion) {
  const datos = await dbConfigSeccion(seccion);
  return {
    ok: true,
    seccion,
    titulo: SECCIONES[seccion].titulo,
    // Lo que el bot usa ahora mismo, y el valor de fábrica (Railway) por si se quiere volver a él.
    vigente: vigente(seccion),
    porDefecto: SECCIONES[seccion].porDefecto(),
    baseDisponible: datos !== null,
    publicada: datos?.publicada ?? null,
    borrador: datos?.borrador ?? null,
    historial: datos?.historial ?? [],
  };
}

/** GET /panel/api/seccion/:seccion */
export async function panelLeerSeccion(req: Request, res: Response) {
  const seccion = seccionDe(req, res);
  if (!seccion) return;
  return res.json({ ...(await estadoSeccion(seccion)), editor: res.locals.editor as Editor });
}

/** PUT /panel/api/seccion/:seccion/borrador { contenido, borradorId } */
export async function panelGuardarBorrador(req: Request, res: Response) {
  const seccion = seccionDe(req, res);
  if (!seccion) return;
  const v = SECCIONES[seccion].validar(req.body?.contenido);
  if (!v.ok) return res.status(400).json({ ok: false, errores: v.errores, error: 'Hay datos que corregir antes de guardar.' });
  const r = await dbConfigGuardarBorrador(seccion, v.valor, res.locals.editor as Editor, idDe(req.body?.borradorId));
  if (!r.ok) return responderFallo(res, r);
  return res.json(await estadoSeccion(seccion));
}

/** DELETE /panel/api/seccion/:seccion/borrador/:id */
export async function panelDescartarBorrador(req: Request, res: Response) {
  const seccion = seccionDe(req, res);
  if (!seccion) return;
  const id = idDe(req.params.id);
  if (!id) return res.status(400).json({ ok: false, error: 'Falta el borrador a descartar.' });
  const r = await dbConfigDescartarBorrador(seccion, id);
  if (!r.ok) return responderFallo(res, r);
  return res.json(await estadoSeccion(seccion));
}

/** POST /panel/api/seccion/:seccion/publicar { borradorId, nota } */
export async function panelPublicar(req: Request, res: Response) {
  const seccion = seccionDe(req, res);
  if (!seccion) return;
  const borradorId = idDe(req.body?.borradorId);
  if (!borradorId) return res.status(400).json({ ok: false, error: 'Falta el borrador a publicar.' });
  const nota = String(req.body?.nota ?? '').trim().slice(0, 300);

  // Se vuelve a validar lo que está guardado, no lo que diga la página: las reglas pueden haber
  // cambiado desde que se guardó el borrador, y lo publicado es lo que el bot va a obedecer.
  const datos = await dbConfigSeccion(seccion);
  if (!datos) return responderFallo(res, { ok: false, motivo: 'sin_db' });
  if (!datos.borrador) return responderFallo(res, { ok: false, motivo: 'sin_borrador' });
  if (datos.borrador.id !== borradorId) return responderFallo(res, { ok: false, motivo: 'conflicto' });
  const v = SECCIONES[seccion].validar(datos.borrador.contenido);
  if (!v.ok) return res.status(400).json({ ok: false, errores: v.errores, error: 'El borrador tiene datos que corregir antes de publicar.' });

  const editor = res.locals.editor as Editor;
  const r = await dbConfigPublicar(seccion, borradorId, nota, editor);
  if (!r.ok) return responderFallo(res, r);
  await refrescarAjustes(dbConfigPublicadas); // el bot de esta instancia lo toma ya, sin esperar el próximo refresco
  void dbInsertAudit({ type: 'config_publicada', detail: { seccion, versionId: r.version.id, editorId: editor.id, editor: editor.nombre, nota } });
  log.info('panel: configuración publicada', { seccion, versionId: r.version.id, editorId: editor.id });
  return res.json(await estadoSeccion(seccion));
}

/** POST /panel/api/seccion/:seccion/restaurar { versionId, borradorId } — copia una versión anterior
 *  al borrador. No publica: se revisa y se publica como cualquier otro cambio. */
export async function panelRestaurar(req: Request, res: Response) {
  const seccion = seccionDe(req, res);
  if (!seccion) return;
  const versionId = idDe(req.body?.versionId);
  if (!versionId) return res.status(400).json({ ok: false, error: 'Falta la versión a restaurar.' });
  const version = await dbConfigVersion(seccion, versionId);
  if (!version) return responderFallo(res, { ok: false, motivo: 'no_existe' });
  const v = SECCIONES[seccion].validar({ ...(SECCIONES[seccion].porDefecto() as object), ...(version.contenido as object) });
  if (!v.ok) return res.status(400).json({ ok: false, errores: v.errores, error: 'Esa versión ya no cumple las reglas actuales y no se puede restaurar tal cual.' });
  const r = await dbConfigGuardarBorrador(seccion, v.valor, res.locals.editor as Editor, idDe(req.body?.borradorId));
  if (!r.ok) return responderFallo(res, r);
  return res.json(await estadoSeccion(seccion));
}

/** POST /panel/api/seccion/horarios/vista { contenido } — cómo se vería la semana con esos horarios. */
export async function panelVistaHorarios(req: Request, res: Response) {
  const v = SECCIONES.horarios.validar(req.body?.contenido);
  if (!v.ok) return res.status(400).json({ ok: false, errores: v.errores });
  return res.json({ ok: true, dias: vistaSemanal(v.valor as Horarios) });
}
