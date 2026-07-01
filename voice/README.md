# Agente de voz (Fase 2) — Vapi + Twilio + Bitrix24

Agente de voz conversacional donde **Vapi** corre la conversación en tiempo real (STT + TTS + barge-in + turn-taking) con **Claude** como cerebro, invoca **nuestro backend** para las herramientas, y nosotros **registramos la llamada en Bitrix24** vía `telephony.externalCall.*`. Arquitectura completa: [`../Fase2-Agente-de-Voz-Vapi-Arquitectura.md`](../Fase2-Agente-de-Voz-Vapi-Arquitectura.md).

## Piezas

| Dónde | Archivo | Qué hace |
|---|---|---|
| Vapi (nube) | [`vapi-assistant.json`](vapi-assistant.json) | Plantilla del asistente: modelo Claude, STT es, TTS es-CL, prompt de voz, herramientas y `server.url`. |
| Backend (Railway) | `src/routes/vapi.ts` | `POST /vapi/events` (tool-calls + end-of-call-report) y `POST /voice/outbound` (llamada saliente). |
| Backend | `src/voice/vapiTools.ts` | Ejecuta las tools (catálogo, detalle, CRM, responsable) por cada `tool-calls`. |
| Backend | `src/crm/telephony.ts` | `telephony.externalCall.*` para registrar la llamada en el CRM. |

## Flujo

```
ENTRANTE:  Cliente → nº Twilio (importado a Vapi) → Vapi (STT+Claude+TTS)
           → tool-calls → POST /vapi/events (catálogo/CRM) → respuesta por voz
           → end-of-call-report → registramos en Bitrix (register→finish→attachRecord + transcripción)

SALIENTE:  Trigger (score alto/manual) → POST /voice/outbound → Vapi POST /call → (mismo flujo)
```

## Requisitos previos (los pone el usuario)

1. **Cuenta Twilio** con un **número chileno +56** habilitado para voz (requiere dirección chilena + documento de la empresa; para outbound automatizado, prefijo **+56600/+56809** según normativa ago-2025).
2. **Cuenta Vapi** → **importar** el número de Twilio ([docs](https://docs.vapi.ai/phone-numbers/import-twilio)) y crear el **asistente** con [`vapi-assistant.json`](vapi-assistant.json) (ajusta `<BACKEND_BASE>` y `<VAPI_SECRET>`).
3. **Scope `telephony`** en la app OAuth de Bitrix24 (reinstalar la app). `telephony.externalCall.*` **no** funciona con webhook entrante.
4. Variables en Railway:
   - `VAPI_API_KEY`, `VAPI_ASSISTANT_ID`, `VAPI_PHONE_NUMBER_ID`, `VAPI_SECRET` (= `server.secret` del asistente).
   - `BITRIX_TELEPHONY_USER_ID` (usuario Bitrix dueño de las llamadas).
   - `VOICE_TRANSFER_FALLBACK` (número/SIP del asesor por defecto).
5. En Vapi, apuntar el `server.url` del asistente a `https://<tu-backend>/vapi/events`.

## Verificación
`GET /debug/config` → bloque `voz`: confirma que `vapiApiKey/vapiAssistantId/vapiPhoneNumberId/vapiSecret` están cargados.

## Estado
PoC / esqueleto: compila y expone el webhook y el disparador de salientes. **Falta** conectar cuentas reales (Twilio nº +56 + Vapi) para pruebas end-to-end y verificar la voz **es-CL** en el picker de Vapi.
