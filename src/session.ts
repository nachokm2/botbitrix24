// Estado mínimo por diálogo para decidir cuándo el bot debe responder.
// - clientId: el usuario que inició la conversación (el cliente).
// - humanTookOver: un operador humano intervino → el bot se calla en esa sesión.
type SessionState = { clientId?: string; humanTookOver?: boolean };

const sessions = new Map<string, SessionState>();

export function getSession(dialogId: string): SessionState {
  let s = sessions.get(dialogId);
  if (!s) {
    s = {};
    sessions.set(dialogId, s);
  }
  return s;
}

export function markHumanTakeover(dialogId: string): void {
  getSession(dialogId).humanTookOver = true;
}
