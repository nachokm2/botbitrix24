import { config } from '../config';
import { log } from '../log';
import type { ContextoLlamada } from '../crm/crmWrite';

/** Arma el saludo inicial y las variables de plantilla para que Vapi abra la llamada YA sabiendo
 *  quién es el cliente y qué le interesaba, en vez de volver a preguntarlo (ver ALT-Voz-Contexto). */
function assistantOverridesDe(contexto?: ContextoLlamada) {
  if (!contexto || (!contexto.nombre && !contexto.programa)) return undefined;
  const saludoNombre = contexto.nombre ? `Hola ${contexto.nombre}` : 'Hola';
  const saludoPrograma = contexto.programa
    ? ` Veo que conversamos sobre el ${contexto.programa}.`
    : '';
  return {
    firstMessage:
      `${saludoNombre}, le saluda el asistente de Postgrados de la Universidad Autónoma de Chile.` +
      `${saludoPrograma} ¿Seguimos con eso o tiene otra consulta?`,
    variableValues: { nombre: contexto.nombre ?? '', programa: contexto.programa ?? '' },
  };
}

/**
 * Dispara una llamada SALIENTE con Vapi (nuestra asistente de voz llama al cliente).
 * Reutilizable desde el endpoint /voice/outbound y desde la herramienta de chat 'solicitar_llamada'.
 * `contexto` (nombre/programa ya guardados en el CRM) personaliza el saludo inicial vía
 * `assistantOverrides`, para que la llamada no vuelva a pedir datos que el cliente ya dio por chat.
 * Devuelve { ok, callId? , error? }. Requiere VAPI_API_KEY + VAPI_ASSISTANT_ID + VAPI_PHONE_NUMBER_ID.
 */
export async function iniciarLlamadaSaliente(
  phone: string,
  contexto?: ContextoLlamada,
): Promise<{ ok: boolean; callId?: string; error?: string }> {
  const num = String(phone ?? '').trim();
  if (!num) return { ok: false, error: 'Falta el teléfono (E.164, ej. +56912345678)' };
  if (!config.vapiApiKey || !config.vapiAssistantId || !config.vapiPhoneNumberId) {
    return { ok: false, error: 'Faltan VAPI_API_KEY / VAPI_ASSISTANT_ID / VAPI_PHONE_NUMBER_ID' };
  }
  try {
    const assistantOverrides = assistantOverridesDe(contexto);
    const r = await fetch('https://api.vapi.ai/call', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.vapiApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assistantId: config.vapiAssistantId,
        phoneNumberId: config.vapiPhoneNumberId,
        customer: { number: num },
        ...(assistantOverrides ? { assistantOverrides } : {}),
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
