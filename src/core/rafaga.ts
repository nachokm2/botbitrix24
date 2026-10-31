/**
 * Mensajes que llegan en ráfaga.
 *
 * Por WhatsApp la gente escribe en trozos: «2.848.000» y, tres segundos después, «?». Cada mensaje
 * disparaba su propio turno y el bot contestaba los dos por separado; al «?» suelto le respondió
 * «Disculpe, parece que el mensaje llegó incompleto», que delata a una máquina (chat 1561991,
 * 31-10-2026: tres respuestas en 36 segundos).
 *
 * Cada mensaje de texto se anota apenas llega, antes de esperar su turno. El turno que está por
 * responder espera a que el chat quede quieto unos segundos y se lleva todos los mensajes anotados
 * desde el suyo: una sola respuesta para la ráfaga entera. Cuando les llega el turno a los mensajes
 * que ya se respondieron así, se descartan.
 *
 * Vive en la memoria del proceso. Con más de una réplica, un mensaje que entra por otra no se junta y
 * se responde aparte, como antes; no se pierde nada. Con RAFAGA_VENTANA_S=0 no se anota nada.
 */

// `de` es quien lo escribió: solo se juntan mensajes del mismo remitente. Un mensaje de una asesora
// que entra en medio de la ráfaga tiene que llegar a su propio turno, que es donde el bot se entera
// de que hay una persona atendiendo y se calla.
type Entrante = { id: string; de: string; texto: string; at: number };

const VIDA_MS = 10 * 60_000; // lo anotado que nadie reclamó se olvida a los 10 min
const pendientes = new Map<string, Entrante[]>();
const absorbidos = new Map<string, number>(); // id del mensaje → hasta cuándo recordarlo

function purgar(ahora: number): void {
  for (const [id, hasta] of absorbidos) if (hasta < ahora) absorbidos.delete(id);
  for (const [dialogo, lista] of pendientes) {
    const vivos = lista.filter((e) => ahora - e.at < VIDA_MS);
    if (vivos.length) pendientes.set(dialogo, vivos);
    else pendientes.delete(dialogo);
  }
}

/** Anota un mensaje de texto apenas llega, antes de que espere su turno. */
export function anotarEntrante(dialogId: string, id: string, de: string, texto: string, ahora = Date.now()): void {
  if (!dialogId || !id || !texto.trim()) return;
  purgar(ahora);
  const lista = pendientes.get(dialogId) ?? [];
  if (lista.some((e) => e.id === id)) return; // Bitrix reenvía eventos
  lista.push({ id, de: String(de ?? ''), texto: texto.trim(), at: ahora });
  pendientes.set(dialogId, lista);
}

/** ¿Este mensaje ya se respondió junto con otro de su ráfaga? */
export function fueAbsorbido(id: string): boolean {
  return absorbidos.has(String(id));
}

/** Cuándo llegó el último mensaje anotado del chat (0 si no hay ninguno). */
export function ultimaLlegada(dialogId: string): number {
  const lista = pendientes.get(dialogId) ?? [];
  return lista.length ? lista[lista.length - 1].at : 0;
}

/**
 * Espera a que el chat quede quieto `ventanaMs` desde el último mensaje, sin pasar de `topeMs` en
 * total: alguien que escribe sin parar igual tiene que recibir respuesta.
 */
export async function esperarFinDeRafaga(dialogId: string, ventanaMs: number, topeMs: number): Promise<void> {
  if (ventanaMs <= 0) return;
  const limite = Date.now() + topeMs;
  while (true) {
    const quieto = Date.now() - ultimaLlegada(dialogId);
    const falta = Math.min(ventanaMs - quieto, limite - Date.now());
    if (falta <= 0) return;
    await new Promise((r) => setTimeout(r, Math.min(falta, 500)));
  }
}

/**
 * Se lleva el mensaje `id` y todos los que el MISMO remitente mandó después en el mismo chat, en
 * orden; esos quedan marcados como respondidos. Los de otros remitentes siguen esperando su turno.
 * Si `id` no estaba anotado (no era texto, o entró por otra réplica) devuelve una lista vacía.
 */
export function tomarRafaga(dialogId: string, id: string, ahora = Date.now()): string[] {
  const lista = pendientes.get(dialogId) ?? [];
  const i = lista.findIndex((e) => e.id === String(id));
  if (i < 0) return [];
  const de = lista[i].de;
  const rafaga = lista.slice(i).filter((e) => e.de === de);
  // Lo anterior a `id` ya tuvo su turno; lo de otros remitentes sigue anotado.
  const quedan = lista.slice(i).filter((e) => e.de !== de);
  if (quedan.length) pendientes.set(dialogId, quedan);
  else pendientes.delete(dialogId);
  for (const e of rafaga.slice(1)) absorbidos.set(e.id, ahora + VIDA_MS);
  return rafaga.map((e) => e.texto);
}

/** Para las pruebas: el estado vive en el proceso y persiste entre casos. */
export function _limpiarRafagas(): void {
  pendientes.clear();
  absorbidos.clear();
}
