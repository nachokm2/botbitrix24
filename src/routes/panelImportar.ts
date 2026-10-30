import type { Request, Response } from 'express';
import { log } from '../log';
import type { Editor } from './panelSesion';

/**
 * POST /panel/api/importar?destino=…&nombre=… — el cuerpo es el documento (Word o PDF). Devuelve la
 * propuesta para la sección de destino (ver ai/importarDocumento.ts); el panel la carga en pantalla
 * como un cambio sin guardar. Nada se guarda ni se publica acá.
 */

export const MAX_DOCUMENTO_BYTES = 10 * 1024 * 1024;
export const TIPOS_DOCUMENTO = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/octet-stream',
];

// Cada importación usa el modelo con el documento completo: un tope por persona evita que un error en
// la página se convierta en gasto.
const IMPORTACIONES = 10;
const VENTANA_MS = 10 * 60_000;
const uso = new Map<number, number[]>();

/** Solo para pruebas: olvida las importaciones hechas. */
export function _reiniciarTopeImportar(): void {
  uso.clear();
}

export async function panelImportar(req: Request, res: Response) {
  // Se cargan recién acá: el importador trae el cliente del modelo, que el resto del panel no necesita.
  const { leerDestino, proponerDesdeDocumento } = await import('../ai/importarDocumento');
  const destino = leerDestino(String(req.query.destino ?? ''));
  if (!destino) return res.status(400).json({ ok: false, error: 'No sé en qué sección cargar ese documento.' });
  const cuerpo = req.body;
  if (!Buffer.isBuffer(cuerpo) || !cuerpo.length) return res.status(400).json({ ok: false, error: 'Elige un documento Word o PDF.' });
  if (cuerpo.length > MAX_DOCUMENTO_BYTES) return res.status(413).json({ ok: false, error: 'El documento pesa más de 10 MB. Sube solo la parte que corresponde.' });

  const editor = res.locals.editor as Editor;
  const ahora = Date.now();
  const recientes = (uso.get(editor.id) ?? []).filter((t) => ahora - t < VENTANA_MS);
  if (recientes.length >= IMPORTACIONES) {
    return res.status(429).json({ ok: false, error: 'Llegaste al máximo de documentos por ahora. Espera unos minutos y sigue.' });
  }
  uso.set(editor.id, [...recientes, ahora]);

  const nombre = String(req.query.nombre ?? 'documento').slice(0, 120);
  try {
    const r = await proponerDesdeDocumento(destino, { nombre, contenido: cuerpo });
    if (!r.ok) return res.status(400).json(r);
    log.info('panel: documento importado', { editorId: editor.id, destino: destino.tipo === 'acciones' ? 'acciones' : `conocimiento:${destino.tema}`, bytes: cuerpo.length });
    return res.json({ ok: true, propuesta: r.propuesta, documento: nombre });
  } catch (e) {
    log.warn('panel: no se pudo importar el documento', { err: String(e).slice(0, 200) });
    return res.status(502).json({ ok: false, error: 'No pudimos leer el documento ahora. Intenta de nuevo en un momento.' });
  }
}
