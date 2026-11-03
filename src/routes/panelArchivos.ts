import type { Request, Response } from 'express';
import { config } from '../config';
import { log } from '../log';
import { dbArchivoGuardar, dbArchivoLeer } from '../store/db';
import type { Editor } from './panelSesion';

/**
 * Archivos subidos desde el panel de configuración: los brochures en PDF y los documentos que el bot
 * comparte desde "Conocimiento" (un título de ejemplo, la licencia), que pueden ser imagen o PDF.
 *
 * Hasta ahora el brochure era un enlace al visor de documentos de Bitrix, que depende de que el archivo
 * no se mueva y de que el enlace no caduque. Subido acá, el archivo lo sirve el propio bot y no depende
 * de nadie más. Se publica por un token aleatorio (store/db.ts:dbArchivoGuardar), no por un número que
 * se pueda recorrer.
 */

export const MAX_PDF_BYTES = 15 * 1024 * 1024;

/** Se reconocen por el contenido, no por la extensión: un archivo renombrado a .pdf no lo es. */
const FORMATOS = [
  { tipo: 'application/pdf', ext: 'pdf', es: (b: Buffer) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { tipo: 'image/jpeg', ext: 'jpg', es: (b: Buffer) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { tipo: 'image/png', ext: 'png', es: (b: Buffer) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
];
/** Los Content-Type que acepta la ruta (ver index.ts). */
export const TIPOS_ARCHIVO = FORMATOS.map((f) => f.tipo);

const nombreSeguro = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\.(pdf|jpe?g|png)$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'documento';

/** POST /panel/api/archivos?nombre=…[&solo=pdf] — el cuerpo es el archivo tal cual. `solo=pdf` es el
 *  brochure de un programa: el bot comprueba que abra un PDF antes de entregarlo. */
export async function panelSubirArchivo(req: Request, res: Response) {
  const soloPdf = req.query.solo === 'pdf';
  const cuerpo = req.body;
  if (!Buffer.isBuffer(cuerpo) || !cuerpo.length) {
    return res.status(400).json({ ok: false, error: soloPdf ? 'Elige un archivo PDF.' : 'Elige una imagen o un PDF.' });
  }
  if (cuerpo.length > MAX_PDF_BYTES) {
    return res.status(413).json({ ok: false, error: 'El archivo pesa más de 15 MB. Comprímelo o pide una versión más liviana.' });
  }
  const formato = FORMATOS.find((f) => (!soloPdf || f.ext === 'pdf') && f.es(cuerpo));
  if (!formato) {
    return res.status(400).json({ ok: false, error: soloPdf ? 'El archivo no es un PDF.' : 'El archivo no es una imagen JPG o PNG ni un PDF.' });
  }
  const nombre = `${nombreSeguro(String(req.query.nombre ?? 'documento'))}.${formato.ext}`;
  const editor = res.locals.editor as Editor;
  const r = await dbArchivoGuardar({ nombre, tipo: formato.tipo, contenido: cuerpo, autor: editor });
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
