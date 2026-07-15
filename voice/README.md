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

---

## M2 — Voz al núcleo (Vapi Custom LLM)

Hay **dos modos** de operar la voz; conviven en el backend y se eligen desde la config del asistente en Vapi:

| Modo | Quién es el "cerebro" | Prompt y tools | Endpoint |
|---|---|---|---|
| **Nativo** (actual) | Claude **dentro de Vapi** | En el dashboard de Vapi ([`vapi-assistant.json`](vapi-assistant.json)) — fuente separada, puede divergir | `POST /vapi/events` (tool-calls + end-of-call) |
| **Custom LLM** (M2) | **Nuestro** motor (`runConversation` + `VOICE_PROFILE`) | En el código (`src/core/channel.ts`) — **misma fuente que WhatsApp** | `POST /vapi/llm/chat/completions` |

En Custom LLM, Vapi hace solo STT/TTS/turn-taking/barge-in y en cada turno llama a nuestro `model.url` en formato OpenAI. Nosotros corremos el **mismo motor** que el chat (perfil de voz: respuestas cortas, sin URLs) y ejecutamos las tools de voz. Así el prompt/tools dejan de estar duplicados en el dashboard.

### Activar Custom LLM (cuando haya cuentas reales conectadas)
1. Crea/actualiza el asistente con [`vapi-assistant-customllm.json`](vapi-assistant-customllm.json): reemplaza `<BACKEND_BASE>` y `<VAPI_SECRET>`.
   - `model.provider = "custom-llm"`, `model.url = https://<tu-backend>/vapi/llm`.
   - `model.headers["x-vapi-secret"] = <VAPI_SECRET>` (así protegemos el endpoint; el backend lo valida en tiempo constante y falla cerrado en producción).
2. Deja `server.url = /vapi/events` para el `end-of-call-report` (el registro de la llamada en Bitrix sigue por ahí, sin cambios).
3. `VAPI_SECRET` en Railway debe coincidir con el header del asistente.

> **Fallback:** el modo nativo (`/vapi/events` tool-calls) queda intacto. Si Custom LLM diera problemas, se revierte cambiando solo la config del asistente en Vapi — sin desplegar código.

### Checklist de validación EN VIVO (requiere Vapi + Twilio +56 reales)
- [ ] Latencia percibida aceptable (tiempo hasta el primer audio) frente al modo nativo.
- [ ] Naturalidad: respuestas de 1–2 frases, sin URLs ni listas (perfil de voz).
- [ ] `consultar_programas` / `detalle_programa` responden con datos reales del catálogo, sin inventar.
- [ ] `registrar_interes_crm` crea/actualiza el lead y dispara las acciones de "lead caliente".
- [ ] `end-of-call-report` sigue registrando la llamada + transcripción en Bitrix.

### Pendiente conocido (para completar en la integración en vivo)
- **Transferencia real de la llamada** (`transferir_a_asesor`): hoy el motor devuelve el mensaje al cliente, pero disparar la transferencia física de Vapi (`transferCall`) desde Custom LLM requiere devolver un `tool_call` de Vapi en la respuesta OpenAI. Se afina contra la cuenta real. Mientras tanto, el modo nativo mantiene la transferencia por la tool de Vapi.
- **Streaming**: hoy emitimos el texto final en un delta SSE. Para reducir el tiempo hasta el primer audio se puede migrar a streaming token-a-token del mensaje final de Claude.
