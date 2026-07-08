import { AsyncLocalStorage } from 'node:async_hooks';

// Contexto por petición para correlacionar logs (requestId ↔ dialogId) a través de
// toda la cadena asíncrona, sin tener que pasar el id por parámetro en cada función.

export type RequestContext = { requestId: string; dialogId?: string };

const als = new AsyncLocalStorage<RequestContext>();

/** Ejecuta `fn` dentro de un contexto de petición (todos los logs que emita lo heredan). */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn);
}

/** Devuelve el contexto de la petición actual, si existe. */
export function getRequestContext(): RequestContext | undefined {
  return als.getStore();
}
