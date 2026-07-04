# Agente de voz self-hosted — Pipecat (Python)

PoC del agente de voz **propio** (sin plataforma gestionada): Twilio (número +56) → **Pipecat** (Deepgram STT es → **Claude** → Azure TTS es-CL, con VAD/barge-in) → nuestro **backend Node** para catálogo/CRM. Arquitectura completa: [`../Fase2-Agente-de-Voz-Pipecat-Arquitectura.md`](../Fase2-Agente-de-Voz-Pipecat-Arquitectura.md).

## Piezas
| Archivo | Rol |
|---|---|
| `server.py` | FastAPI: `/twiml` (Connect+Stream), `/ws` (audio Twilio → pipeline), `/dialout` (saliente) |
| `bot.py` | Pipeline Pipecat: STT→Claude→TTS, VAD/barge-in, tools que llaman a nuestro backend |
| `requirements.txt` / `env.example` | Dependencias y variables |

En el **backend Node** (ya desplegado) se reutilizan: `POST /voice/tool` (ejecuta catálogo/CRM) y `POST /voice/call/finish` (registra la llamada en Bitrix).

## Correr en local (pruebas)
```bash
cd voice-pipecat
python -m venv .venv && source .venv/bin/activate   # (Windows: .venv\Scripts\activate)
pip install -r requirements.txt
cp env.example .env   # y completa las claves
python server.py      # uvicorn en :7860
ngrok http 7860       # copia la URL https en PUBLIC_URL del .env y reinicia
```

## Conectar Twilio
- **Entrante:** en tu número Twilio → Voice → "A call comes in" = **Webhook POST** `https://<PUBLIC_URL>/twiml`.
- **Saliente:** `curl -X POST https://<PUBLIC_URL>/dialout -H "Content-Type: application/json" -d '{"to_number":"+569XXXXXXXX"}'`.

## Requisitos previos
- Número **Twilio +56** (con el Regulatory Bundle de la UA) — el mismo de la vía Vapi.
- Cuentas/keys: **Anthropic** (Claude), **Deepgram** (STT es), **Azure Speech** (TTS es-CL), **Twilio**.
- En el backend Node: scope **`telephony`** en la app Bitrix + `BITRIX_TELEPHONY_USER_ID`, y `VAPI_SECRET` (= `VOICE_SECRET` de aquí).

## Notas
- La API de Pipecat está en transición: `bot.py` usa el patrón clásico (`PipelineTask`/`PipelineRunner`). Fija la versión de `pipecat-ai` en `requirements.txt` y ajusta si usas la variante nueva (`PipelineWorker`). Ver la doc y el ejemplo oficial `pipecat-ai/pipecat-examples` → `twilio-chatbot`.
- Es un **servicio en tiempo real 24/7**: una sesión/pipeline por llamada. Despliega en un host con WebSocket (Railway/Fly) y monitorea.
