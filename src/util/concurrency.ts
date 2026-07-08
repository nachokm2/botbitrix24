// Utilidades de concurrencia en memoria (per-proceso). Para multi-réplica, la serialización
// fuerte por diálogo requeriría además un lock distribuido (Redis/Redlock).

/** Semáforo simple: limita cuántas tareas corren a la vez; el resto encola. */
export function createSemaphore(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const release = () => {
    active--;
    const nextStart = queue.shift();
    if (nextStart) nextStart();
  };
  return function run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        active++;
        fn().then(resolve, reject).finally(release);
      };
      if (active < max) start();
      else queue.push(start);
    });
  };
}

/** Serializa tareas por clave: dos tareas con la misma clave nunca se solapan (se encadenan en orden). */
export function createKeyedLock() {
  const chains = new Map<string, Promise<unknown>>();
  return function run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = chains.get(key) ?? Promise.resolve();
    // La cadena continúa pase lo que pase con la tarea previa (resuelva o falle).
    const next = prev.then(fn, fn);
    // Versión "silenciada" (nunca rechaza) que sirve de cola para el siguiente y evita unhandled rejection.
    const silenced = next.then(
      () => undefined,
      () => undefined,
    );
    chains.set(key, silenced);
    // Limpieza: si al terminar esta tarea sigue siendo la última de la cadena, libera la clave.
    void silenced.finally(() => {
      if (chains.get(key) === silenced) chains.delete(key);
    });
    return next;
  };
}
