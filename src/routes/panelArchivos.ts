import type { Request, Response } from 'express';
import { config } from '../config';
import { log } from '../log';
import { dbArchivoGuardar, dbArchivoLeer } from '../store/db';
import type { Editor } from './panelSesion';

/**
 * Archivos subidos desde el panel de configuración: hoy, los brochures en PDF.
 *
 * Hasta ahora el brochure era un enlace al visor de documentos de Bitrix, que depende de que el archivo
 * no se mueva y de que el enlace no caduque. Subido acá, el PDF lo sirve el propio bot y no depende de
 * nadie más. Se publica por un token aleatorio (store/db.ts:dbArchivoGuardar), no por un número que se
 * pueda recorrer.
 */

export const MAX_PDF_BYTES = 15 * 1024 * 1024;

const nombreSeguro = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\.pdf$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'brochure';

/** POST /panel/api/archivos?nombre=… — el cuerpo es el PDF tal cual (Content-Type: application/pdf). */
export async function panelSubirArchivo(req: Request, res: Response) {
  const cuerpo = req.body;
  if (!Buffer.isBuffer(cuerpo) || !cuerpo.length) {
    return res.status(400).json({ ok: false, error: 'Elige un archivo PDF.' });
  }
  if (cuerpo.length > MAX_PDF_BYTES) {
    return res.status(413).json({ ok: false, error: 'El PDF pesa más de 15 MB. Comprímelo o pide una versión más liviana.' });
  }
  // Se mira el contenido, no la extensión: un archivo renombrado a .pdf no lo es.
  if (cuerpo.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return res.status(400).json({ ok: false, error: 'El archivo no es un PDF.' });
  }
  const nombre = `${nombreSeguro(String(req.query.nombre ?? 'brochure'))}.pdf`;
  const editor = res.locals.editor as Editor;
  const r = await dbArchivoGuardar({ nombre, tipo: 'application/pdf', contenido: cuerpo, autor: editor });
  if (!r) {
    return res.status(503).json({ ok: false, error: 'La base de datos no está disponible en este momento. Intenta de nuevo en unos minutos.' });
  }
  log.info('panel: archivo subido', { editorId: editor.id, bytes: cuerpo.length });
  return res.json({ ok: true, nombre, url: `${config.baseUrl}/archivos/${r.token}/${nombre}` });
}

/** GET /archivos/:token/:nombre — público: es el enlace que el bot le entrega a la persona. */
export async function servirArchivo(req: Request, res: Response) {
  const token = String(req.params.token ?? '');
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) return res.status(404).send('No encontrado.');
  const a = await dbArchivoLeer(token);
  if (!a) return res.status(404).send('No encontrado.');
  res.set('Content-Type', a.tipo);
  res.set('Content-Disposition', `inline; filename="${a.nombre}"`);
  res.set('X-Content-Type-Options', 'nosniff');
  // El token cambia si cambia el contenido: lo servido bajo un token no cambia nunca.
  res.set('Cache-Control', 'public, max-age=86400, immutable');
  return res.send(a.contenido);
}
