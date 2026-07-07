import { config } from '../config';
import { log } from '../log';

/**
 * Dispara una llamada SALIENTE con Vapi (nuestra asistente de voz llama al cliente).
 * Reutilizable desde el endpoint /voice/outbound y desde la herramienta de chat 'solicitar_llamada'.
 * Devuelve { ok, callId? , error? }. Requiere VAPI_API_KEY + VAPI_ASSISTANT_ID + VAPI_PHONE_NUMBER_ID.
 */
export async function iniciarLlamadaSaliente(
  phone: string,
): Promise<{ ok: boolean; callId?: string; error?: string }> {
  const num = String(phone ?? '').trim();
  if (!num) return { ok: false, error: 'Falta el teléfono (E.164, ej. +56912345678)' };
  if (!config.vapiApiKey || !config.vapiAssistantId || !config.vapiPhoneNumberId) {
    return { ok: false, error: 'Faltan VAPI_API_KEY / VAPI_ASSISTANT_ID / VAPI_PHONE_NUMBER_ID' };
  }
  try {
    const r = await fetch('https://api.vapi.ai/call', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.vapiApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assistantId: config.vapiAssistantId,
        phoneNumberId: config.vapiPhoneNumberId,
        customer: { number: num },
      }),
    });
    const json: any = await r.json();
    if (!r.ok) {
      const error = typeof json === 'string' ? json : JSON.stringify(json);
      log.warn('iniciarLlamadaSaliente: Vapi rechazó la llamada', { error });
      return { ok: false, error };
    }
    const callId = json.id ?? json.callId ?? undefined;
    log.info('iniciarLlamadaSaliente: llamada creada', { callId, phone: num });
    return { ok: true, callId };
  } catch (e) {
    log.error('iniciarLlamadaSaliente falló', { err: String(e) });
    return { ok: false, error: String(e) };
  }
}
