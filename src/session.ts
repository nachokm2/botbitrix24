import { getJson, setJson } from './store/kv';

// Estado por diálogo (persistido en KV) para decidir cuándo responde el bot.
// - clientId: usuario que inició la conversación (el cliente).
// - humanTookOver: un operador intervino → el bot se calla en esa sesión.
export type SessionState = {
  clientId?: string;
  humanTookOver?: boolean;
  lastScore?: number;
  intencion?: string;
  sentimiento?: string;
  lastStage?: string;
  escalatedByScore?: boolean;
  dealCategory?: number;
  responsableId?: number; // ASSIGNED_BY_ID del deal (asesor a cargo), cacheado
  briefingDone?: boolean; // ya se generó el resumen para el asesor (evita duplicados)
};

const KEY = (dialogId: string) => `sess:${dialogId}`;
const TTL_SEC = 6 * 3600;

export async function getSession(dialogId: string): Promise<SessionState> {
  return (await getJson<SessionState>(KEY(dialogId))) ?? {};
}

export async function saveSession(dialogId: string, s: SessionState): Promise<void> {
  await setJson(KEY(dialogId), s, TTL_SEC);
}

export async function markHumanTakeover(dialogId: string): Promise<void> {
  const s = await getSession(dialogId);
  s.humanTookOver = true;
  await saveSession(dialogId, s);
}
