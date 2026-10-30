import { horarios } from './ajustes';
import { callBitrix } from '../bitrix/client';
import type { Auth } from '../store';

// "Ritmo humano": el bot no contesta al instante. Muestra "escribiendo…" y espera un rato aleatorio
// antes de responder, para que la persona no sienta que habla con un robot. El rango va en segundos:
// lo publicado en el panel (sección Horarios) o, si no hay nada, RESPUESTA_DELAY_MIN_S /
// RESPUESTA_DELAY_MAX_S; con max<=0 no espera (comportamiento previo).

// El indicador de "escribiendo" de Bitrix expira solo a los ~25 s; se re-emite durante la espera para
// que siga visible aunque el delay sea largo.
const TYPING_REFRESH_MS = 18_000;

/** Milisegundos de espera para este turno: aleatorio en [min, max] segundos. 0 = sin espera. */
export function delayHumanoMs(): number {
  const { ritmoMinS, ritmoMaxS: maxS } = horarios();
  if (maxS <= 0) return 0;
  const minS = Math.min(Math.max(0, ritmoMinS), maxS);
  return Math.round((minS + Math.random() * (maxS - minS)) * 1000);
}

/**
 * Muestra "escribiendo…" y espera un tiempo aleatorio antes de que el bot responda. Mantiene vivo el
 * indicador re-emitiéndolo durante la espera. Sin delay configurado, solo muestra el indicador una vez
 * (idéntico a lo que hacía el handler antes). El envío de "escribiendo" es best-effort: si falla, se
 * ignora (no debe impedir la respuesta).
 */
export async function esperarComoHumano(botId: number | undefined, dialogId: string, auth: Auth): Promise<void> {
  const typing = () =>
    callBitrix('imbot.chat.sendTyping', { BOT_ID: botId, DIALOG_ID: dialogId }, auth).catch(() => {});
  await typing();
  const fin = Date.now() + delayHumanoMs();
  while (true) {
    const resta = fin - Date.now();
    if (resta <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(resta, TYPING_REFRESH_MS)));
    if (Date.now() < fin) await typing(); // mantiene el indicador vivo en esperas largas
  }
}
