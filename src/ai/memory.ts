import { getJson, setJson, kvDel } from '../store/kv';

// Memoria de conversación por diálogo, persistida en KV (Redis o memoria).
// Complementa la memoria de largo plazo del CRM (notas del timeline, §Fase 4).
const KEY = (dialogId: string) => `mem:${dialogId}`;
const MAX_TURNS = 24;
const TTL_SEC = 6 * 3600; // expira a las 6 h de inactividad

export async function getHistory(dialogId: string): Promise<any[]> {
  const raw = (await getJson<any[]>(KEY(dialogId))) ?? [];
  // Autorepara historiales ya corrompidos en KV por el bug del slice ciego (anterior a este fix),
  // para no seguir arrastrando el 400 de Anthropic en diálogos guardados antes de corregirlo.
  return trimHistory(raw, MAX_TURNS);
}

export async function setHistory(dialogId: string, messages: any[]): Promise<void> {
  await setJson(KEY(dialogId), trimHistory(messages, MAX_TURNS), TTL_SEC);
}

/** Un mensaje que NO puede abrir la conversación para la API de Anthropic: un turno 'assistant'
 *  (debe empezar en 'user'), o un 'user' que es puro tool_result (continuación de un tool_use
 *  del mensaje anterior, ya recortado). */
function esInicioInvalido(message: any): boolean {
  if (!message) return false;
  if (message.role === 'assistant') return true;
  const content = message.content;
  return Array.isArray(content) && content.length > 0 && content.every((b: any) => b?.type === 'tool_result');
}

/** Recorta a los últimos `maxTurns` mensajes SIN dejar un tool_result huérfano (o un turno
 *  'assistant') al inicio: un slice ciego puede cortar justo entre un tool_use y su tool_result,
 *  y Anthropic rechaza ese historial con 400 (visto en producción con conversaciones largas). */
function trimHistory(messages: any[], maxTurns: number): any[] {
  let cut = messages.slice(-maxTurns);
  while (cut.length && esInicioInvalido(cut[0])) cut = cut.slice(1);
  return cut;
}

export async function resetHistory(dialogId: string): Promise<void> {
  await kvDel(KEY(dialogId));
}
