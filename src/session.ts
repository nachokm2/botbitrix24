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
  autoCalled?: boolean; // ya se disparó la llamada de voz por score (evita llamar dos veces)
  programaCrm?: string; // último programa de interés escrito al CRM en esta conversación
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

// ── Traspaso a una persona, por SESIÓN de Open Lines ────────────────────────────────────────────
// El estado de arriba vive 6 h. Pasado ese plazo el bot "olvidaba" que había derivado y volvía a
// contestar en un chat que ya atendía un asesor. Caso real del piloto de Carver: el bot derivó de
// madrugada, un asesor tomó el chat y conversó con el cliente, y al mediodía el bot volvió a
// responder —hablando como ese mismo asesor y nombrándolo en tercera persona—. Bitrix lo confirmaba
// al rechazar sus traspasos con "Operator is not a bot".
//
// El traspaso se recuerda por la SESIÓN de Open Lines (el 6.º campo de CHAT_ENTITY_DATA_1): mientras
// dure esa sesión, el bot calla. Cuando Bitrix abre una sesión nueva, el bot vuelve a atender.

const TRASPASO_KEY = (dialogId: string) => `traspaso:${dialogId}`;
const TRASPASO_TTL_SEC = 30 * 24 * 3600;
// Sin id de sesión (evento incompleto) no se puede saber cuándo terminó la atención humana: se
// recuerda por un plazo acotado en vez de para siempre.
const TRASPASO_SIN_SESION_MS = 72 * 3600_000;

type Traspaso = { sesion: string | null; at: number; motivo: string };

/** Id de la sesión de Open Lines a partir de CHAT_ENTITY_DATA_1 ("Y|DEAL|123|N|N|<sesión>|<ts>|…"). */
export function sesionOpenLines(chatEntityData1: unknown): string | null {
  if (typeof chatEntityData1 !== 'string') return null;
  const id = chatEntityData1.split('|')[5];
  return id && /^\d+$/.test(id) && id !== '0' ? id : null;
}

export async function marcarTraspaso(dialogId: string, sesion: string | null, motivo: string): Promise<void> {
  await setJson(TRASPASO_KEY(dialogId), { sesion, at: Date.now(), motivo } satisfies Traspaso, TRASPASO_TTL_SEC);
}

/** ¿Hay un traspaso a una persona vigente para esta conversación en esta sesión? */
export async function traspasoVigente(dialogId: string, sesion: string | null): Promise<Traspaso | null> {
  const t = await getJson<Traspaso>(TRASPASO_KEY(dialogId));
  if (!t) return null;
  if (t.sesion && sesion) return t.sesion === sesion ? t : null;
  return Date.now() - t.at < TRASPASO_SIN_SESION_MS ? t : null;
}
