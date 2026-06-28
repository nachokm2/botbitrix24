import { getJson, setJson, kvDel } from '../store/kv';

// Memoria de conversación por diálogo, persistida en KV (Redis o memoria).
// Complementa la memoria de largo plazo del CRM (notas del timeline, §Fase 4).
const KEY = (dialogId: string) => `mem:${dialogId}`;
const MAX_TURNS = 24;
const TTL_SEC = 6 * 3600; // expira a las 6 h de inactividad

export async function getHistory(dialogId: string): Promise<any[]> {
  return (await getJson<any[]>(KEY(dialogId))) ?? [];
}

export async function setHistory(dialogId: string, messages: any[]): Promise<void> {
  await setJson(KEY(dialogId), messages.slice(-MAX_TURNS), TTL_SEC);
}

export async function resetHistory(dialogId: string): Promise<void> {
  await kvDel(KEY(dialogId));
}
