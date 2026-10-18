import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { log } from '../log';

/** Texto de un error para el log, sin riesgo de que describirlo lance a su vez: el body urlencoded
 *  llega parseado con allowPrototypes, así que un objeto puede traer un toString que no es función. */
export function describirError(x: unknown): string {
  if (x instanceof Error) return x.stack ?? `${x.name}: ${x.message}`;
  try {
    return String(x);
  } catch {
    return Object.prototype.toString.call(x);
  }
}

/**
 * Envuelve un handler async para que su rechazo llegue al manejador de errores de Express.
 *
 * Express 4 no espera la promesa que devuelve un handler: si se rechaza, queda sin manejar y Node
 * termina el proceso. Bastaba un POST /install sin credenciales con `application_token[toString]=1`
 * para tumbar el bot: el parser urlencoded usa qs con allowPrototypes, ese campo llega como un objeto
 * cuyo toString no es función, y String() lanza. Bitrix no reintenta los eventos que se pierden
 * mientras el servicio reinicia, y la política de Railway deja de reiniciarlo tras 5 caídas.
 */
export function manejarAsync(fn: (req: Request, res: Response, next: NextFunction) => unknown): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/** Último recurso para el error de cualquier ruta: se registra y se responde 500 sin detalles internos. */
export function manejadorDeErrores(err: unknown, req: Request, res: Response, next: NextFunction): void {
  log.error('error no manejado en una ruta', { method: req.method, path: req.path, err: describirError(err) });
  // Si la respuesta ya empezó (p.ej. el ACK 200 a Bitrix), Express pide delegar en su manejador por
  // defecto, que cierra la conexión.
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: 'internal_error' });
}
