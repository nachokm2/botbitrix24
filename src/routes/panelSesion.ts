import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Sesión del panel de configuración (routes/panelConfig.ts).
 *
 * Quien entra lo dice Bitrix: al abrir la pestaña, Bitrix entrega el token del usuario y el servidor
 * le pregunta a Bitrix quién es (user.current). Desde ahí, la página usa una credencial propia, firmada
 * y de corta duración, que manda en cada llamada (Authorization: Bearer …).
 *
 * No es una cookie a propósito: el panel vive dentro de un iframe de Bitrix24, en otro dominio, y los
 * navegadores bloquean cada vez más las cookies de terceros (Safari ya las bloquea siempre). Y al no
 * viajar sola, la credencial tampoco abre la puerta a peticiones forjadas desde otra página.
 *
 * Variables:
 *  - PANEL_EDITORES: IDs de usuario de Bitrix24 que pueden editar, separados por coma. Vacía = el
 *    panel no existe (responde 404), que es como queda en Postgrados.
 *  - PANEL_SECRETO (opcional): clave para firmar. Sin ella se deriva de TOKEN_ENC_KEY o ADMIN_TOKEN,
 *    para no exigir una variable más; sin ninguna de las tres, el panel no firma y no deja entrar.
 */

export const DURACION_SESION_MS = 8 * 3600_000;

export type Editor = { id: number; nombre: string };

export function editoresPanel(): number[] {
  return (process.env.PANEL_EDITORES ?? '')
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

export function esEditor(id: number): boolean {
  return editoresPanel().includes(id);
}

function clave(): Buffer | null {
  const base = process.env.PANEL_SECRETO || process.env.TOKEN_ENC_KEY || process.env.ADMIN_TOKEN || '';
  if (base.length < 16) return null;
  // Separación de dominio: aunque la base sea la clave de cifrado de tokens, la que firma sesiones es
  // otra y no sirve para descifrar nada.
  return crypto.createHmac('sha256', base).update('panel-config-sesion-v1').digest();
}

const b64 = (x: Buffer | string) => Buffer.from(x).toString('base64url');

/** Credencial firmada para `e`, válida DURACION_SESION_MS. null si no hay clave para firmar. */
export function firmarSesion(e: Editor, ahora = Date.now()): string | null {
  const k = clave();
  if (!k) return null;
  const cuerpo = b64(JSON.stringify({ uid: e.id, nombre: e.nombre, exp: ahora + DURACION_SESION_MS }));
  const firma = b64(crypto.createHmac('sha256', k).update(cuerpo).digest());
  return `${cuerpo}.${firma}`;
}

/** El editor de una credencial válida, vigente y de alguien que SIGUE en la lista; si no, null. */
export function verificarSesion(token: string, ahora = Date.now()): Editor | null {
  const k = clave();
  if (!k || typeof token !== 'string') return null;
  const [cuerpo, firma, ...resto] = token.split('.');
  if (!cuerpo || !firma || resto.length) return null;
  const esperada = crypto.createHmac('sha256', k).update(cuerpo).digest();
  const recibida = Buffer.from(firma, 'base64url');
  if (recibida.length !== esperada.length || !crypto.timingSafeEqual(recibida, esperada)) return null;
  let datos: any;
  try {
    datos = JSON.parse(Buffer.from(cuerpo, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Number.isInteger(datos?.uid) || typeof datos?.exp !== 'number' || datos.exp <= ahora) return null;
  // Se revisa la lista en cada llamada: quitar a alguien de PANEL_EDITORES le corta el acceso en el
  // acto, sin esperar a que venza su credencial.
  if (!esEditor(datos.uid)) return null;
  return { id: datos.uid, nombre: String(datos.nombre ?? '') };
}

/** Guard de la API del panel. Deja el editor en res.locals.editor. */
export function requirePanelSesion(req: Request, res: Response, next: NextFunction) {
  if (!editoresPanel().length) return res.status(404).json({ ok: false, error: 'No encontrado.' });
  const m = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
  const editor = m ? verificarSesion(m[1]) : null;
  if (!editor) {
    return res.status(401).json({ ok: false, error: 'Tu sesión venció o no es válida. Vuelve a abrir el panel desde Bitrix24.' });
  }
  res.locals.editor = editor;
  next();
}
