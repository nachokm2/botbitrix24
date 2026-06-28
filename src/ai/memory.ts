// Memoria de conversación por diálogo (en memoria, suficiente para el PoC).
// En producción: Redis/Postgres + resumen rolling anclado al Deal (ver §8.4 del documento).
const store = new Map<string, any[]>();
const MAX_TURNS = 24; // limita el historial enviado al modelo

export function getHistory(dialogId: string): any[] {
  return store.get(dialogId) ?? [];
}

export function setHistory(dialogId: string, messages: any[]): void {
  store.set(dialogId, messages.slice(-MAX_TURNS));
}

export function resetHistory(dialogId: string): void {
  store.delete(dialogId);
}
