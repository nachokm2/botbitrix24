# Agente de voz (Fase 2) — Voximplant VoxEngine

Esqueleto del agente de voz conversacional (STT → Claude → TTS) sobre **Voximplant standalone**, con registro de llamadas en el CRM de Bitrix24. La arquitectura completa está en [`../Fase2-Agente-de-Voz-Voximplant-Arquitectura.md`](../Fase2-Agente-de-Voz-Voximplant-Arquitectura.md).

## Piezas

| Dónde corre | Archivo | Qué hace |
|---|---|---|
| Voximplant (nube) | [`voxengine-scenario.js`](voxengine-scenario.js) | Contesta/lanza la llamada, ASR es-CL, TTS es-CL, barge-in, HTTP a nuestro backend, desvío a humano. |
| Nuestro backend (Railway) | `src/routes/voice.ts` | `POST /voice/call/register`, `POST /voice/turn`, `POST /voice/call/finish`. |
| Nuestro backend | `src/voice/voiceAgent.ts` | Turno del agente de voz (Claude + herramientas: catálogo, detalle, CRM, transferir, finalizar). |
| Nuestro backend | `src/crm/telephony.ts` | `telephony.externalCall.*` (register/finish/attachRecord/searchCrmEntities). |

## Requisitos previos (los pone el usuario)

1. **Cuenta Voximplant** (plataforma, no Kit) → una *Application* con un *Scenario* (pega `voxengine-scenario.js`) y una *routing rule*.
2. **Número de teléfono** en Voximplant y adjuntarlo a la Application. ⚠️ **Verificar cobertura Chile (+56)** en el panel; puede requerir KYC o soporte.
3. **Scope `telephony`** en la app OAuth de Bitrix24 (reinstalar la app para que el token lo incluya). `telephony.externalCall.*` **no** funciona con webhook entrante.
4. Variables de entorno en Railway:
   - `BITRIX_TELEPHONY_USER_ID` — usuario Bitrix "dueño" de las llamadas del bot.
   - `BITRIX_TELEPHONY_LINE` — (opcional) número de línea externa.
   - `VOICE_MODEL` — (opcional) modelo Claude para la voz (default Haiku).
   - `VOICE_TRANSFER_FALLBACK` — número PSTN / SIP URI del asesor por defecto para derivar.
   - `VOICE_SHARED_SECRET` — mismo valor que en el escenario (`VOICE_SECRET`).
5. En `voxengine-scenario.js`: fijar `BACKEND_BASE`, `VOICE_SECRET`, `CALLER_ID`.

## Flujo

```
ENTRANTE:  Cliente → nº Voximplant → escenario → /voice/call/register → saludo (TTS)
           → [ASR es-CL → /voice/turn (Claude) → TTS es-CL] (bucle, con barge-in)
           → transfer (forwardCallToPSTN) o finalizar → /voice/call/finish → CRM

SALIENTE:  Trigger (score alto/manual) → HTTP API StartScenarios(rule_id, {to})
           → callPSTN → (mismo bucle)
```

## Estado

PoC / esqueleto: compila y expone los endpoints. **Falta** conectar cuentas reales (Voximplant + número + scope telephony) para pruebas end-to-end, y afinar barge-in con Silero VAD + Pipecat (ver doc de arquitectura, §6).
