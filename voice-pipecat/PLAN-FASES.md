# Plan por fases — Agente de voz propio (Pipecat)

Guía detallada para construir y poner en marcha el agente de voz **self-hosted** (Twilio → Pipecat → Deepgram/Claude/Azure → nuestro backend/CRM). Cada fase tiene **objetivo, pasos, criterio de aceptación**. Arquitectura: [`../Fase2-Agente-de-Voz-Pipecat-Arquitectura.md`](../Fase2-Agente-de-Voz-Pipecat-Arquitectura.md).

> Estado de dependencias: Anthropic ✅ · Twilio número +56 ⏳ (validando). **No te bloquees**: las Fases 0–3 se pueden probar con un **número Twilio de prueba (trial, US)** apuntado a ngrok; el +56 real solo hace falta para producción/salientes locales (Fase 5).

---

## Fase 0 — Preparación (cuentas, keys, entorno)

**Objetivo:** tener todas las llaves y el servicio corriendo en local.

**0.1 Cuentas y keys**
- **Anthropic** (Claude) ✅ — ya la tienes → `ANTHROPIC_API_KEY`.
- **Deepgram** (STT): crea cuenta en deepgram.com → API Keys → `DEEPGRAM_API_KEY` (tiene crédito gratis inicial).
- **Azure Speech** (TTS es-CL): en portal.azure.com crea un recurso **Speech Services** → copia **Key** y **Region** (ej. `eastus`) → `AZURE_SPEECH_API_KEY`, `AZURE_SPEECH_REGION`.
- **Twilio**: cuenta creada ✅. Mientras validan el +56, ten a mano `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` y un **número de prueba** (o el trial) para las Fases 1–3.

**0.2 Entorno local**
```bash
cd voice-pipecat
python -m venv .venv
# Windows: .venv\Scripts\activate   ·  Mac/Linux: source .venv/bin/activate
pip install -r requirements.txt
cp env.example .env      # completa TODAS las claves
```
- Instala **ngrok** (ngrok.com) para exponer el local con HTTPS/WSS.

**0.3 Backend Node (lo que ya está desplegado)**
- Define en Railway `VAPI_SECRET` (será el `VOICE_SECRET` del `.env` de Pipecat — deben ser IGUALES).
- (Para Fase 4) agrega el scope **`telephony`** a la app Bitrix y define `BITRIX_TELEPHONY_USER_ID`.

**✅ Aceptación:** `python server.py` levanta uvicorn en `:7860` y `GET http://localhost:7860/health` responde `{"ok":true}`.

---

## Fase 1 — Eco de voz (audio Twilio ↔ Pipecat en es-CL)

**Objetivo:** contestar una llamada real y validar el pipeline de audio (STT→TTS) en español de Chile.

**1.1 Fijar versión de Pipecat (importante)**
- La API de Pipecat evoluciona. En `requirements.txt` fija una versión concreta y clónala como referencia:
```bash
git clone https://github.com/pipecat-ai/pipecat-examples
# revisa examples/twilio-chatbot/inbound (y outbound) en esa MISMA versión
```
- Si tu versión usa el patrón nuevo (`PipelineWorker`/`WorkerRunner`, `LLMContext`), ajusta `bot.py` según ese ejemplo (el esqueleto usa el patrón clásico `PipelineTask`/`PipelineRunner`).

**1.2 Exponer y conectar Twilio**
```bash
python server.py           # en una terminal
ngrok http 7860            # en otra → copia la URL https
```
- Pon esa URL en `.env` → `PUBLIC_URL=https://xxxx.ngrok.io` y **reinicia** `server.py`.
- En Twilio → tu número (trial/US mientras) → **Voice → "A call comes in" = Webhook, POST** `https://xxxx.ngrok.io/twiml`.

**1.3 Prueba**
- Llama al número. Debe: contestar → **saludar en es-CL** → repites algo → responde.
- Mira los logs: verás la transcripción de Deepgram.

**✅ Aceptación:** conversación de voz ida y vuelta en es-CL (aunque las respuestas aún sean genéricas del LLM). Sin errores de WebSocket.

**Problemas típicos:** voz robótica/idioma equivocado → revisa `es-CL-CatalinaNeural`; sin audio de vuelta → `add_wav_header=False` y `serializer` bien seteados; el WS no conecta → `PUBLIC_URL` con `wss://` correcto.

---

## Fase 2 — Cerebro + herramientas (Claude + catálogo/CRM)

**Objetivo:** que responda de programas/precios (exactos) y capture datos, usando nuestro backend.

**2.1 Config**
- `.env`: `BACKEND_BASE=https://botbitrix24-production.up.railway.app` y `VOICE_SECRET` = el `VAPI_SECRET` del backend.
- El `bot.py` ya registra las 4 tools (`consultar_programas`, `detalle_programa`, `registrar_interes_crm`, `transferir_a_asesor`) que llaman a `POST /voice/tool`.

**2.2 Prueba (guion)**
1. "¿Qué diplomados tienen de salud?" → lista corta.
2. "¿Cuánto cuesta el Diplomado en Ciberseguridad?" → **arancel exacto** ($1.090.000). Prueba 3-4 programas distintos.
3. Da nombre, correo y teléfono → debe registrarlos.
4. "Quiero hablar con un asesor" → deriva.

**✅ Aceptación:** precios correctos (lookup exacto, no inventa); los datos aparecen en el **CRM de Bitrix**; la derivación responde con el asesor.

---

## Fase 3 — Fluidez (barge-in + latencia)

**Objetivo:** interrumpible y con latencia objetivo **< 1 s**.

**3.1 Ajustes en `bot.py`**
- Barge-in: `PipelineParams(allow_interruptions=True)` (ya está) + `SileroVADAnalyzer(VADParams(stop_secs=0.2, start_secs=0.2))` para que corte rápido.
- Latencia del modelo: `VOICE_MODEL=claude-3-5-haiku-...` (Haiku) y respuestas cortas (system prompt ya lo pide); opcional `max_tokens` bajo.
- TTS rápido: Azure es-CL (bajo). Alternativa aún más rápida: **Cartesia** (`CartesiaTTSService`).
- Activa métricas: `PipelineParams(enable_metrics=True, enable_usage_metrics=True)` para ver tiempos por componente en logs.

**3.2 Prueba**
- Interrumpe al bot mientras habla → debe callarse y escucharte.
- Mide el tiempo respuesta; apunta a ~700–1000 ms.

**✅ Aceptación:** se puede interrumpir; latencia aceptable y estable.

---

## Fase 4 — Registro en el CRM (fin de llamada)

**Objetivo:** cada llamada queda en Bitrix (lead/contacto + duración + transcripción + grabación).

**4.1 Requisitos**
- App Bitrix con scope **`telephony`** (reinstalar) + `BITRIX_TELEPHONY_USER_ID` en el backend.
- (Opcional) grabación: si activas grabación en Twilio, pásale la URL a `/voice/call/finish` (`recordingUrl`).

**4.2 Cómo funciona**
- Al colgar, `bot.py` postea a `POST /voice/call/finish` con `duration` + `transcript`; el backend hace `externalCall.register→finish→attachRecord` y deja la nota.

**✅ Aceptación:** tras una llamada, en el CRM aparece la **actividad de llamada** vinculada a lead/contacto, con la **transcripción**.

---

## Fase 5 — Saliente + despliegue en la nube

**Objetivo:** la IA llama a leads y el servicio corre 24/7 (no en tu PC).

**5.1 Saliente**
```bash
curl -X POST https://<PUBLIC_URL>/dialout -H "Content-Type: application/json" \
  -d '{"to_number":"+569XXXXXXXX"}'
```
- `from_` = tu número Twilio (`TWILIO_FROM_NUMBER`). Con el **+56 real** aprobado.
- ⚠️ Salientes automatizadas masivas en Chile: prefijos **+56600/+56809** (normativa ago-2025).

**5.2 Despliegue (Railway / Fly)**
- Empaqueta el servicio (Dockerfile; hay uno de referencia en el ejemplo oficial `twilio-chatbot`).
- Necesita **WSS público estable** y CPU suficiente (una sesión/pipeline por llamada).
- Variables de entorno = las del `.env`. `PUBLIC_URL` = el dominio del deploy.
- Apunta el webhook de Twilio (`/twiml`) al dominio de producción.

**✅ Aceptación:** llamada **entrante y saliente** end-to-end funcionando en la nube, con registro en el CRM.

---

## Operación / hardening (post-PoC)
- **Monitoreo:** latencia por componente, tasa de error, caídas de WS, reconexión.
- **Concurrencia:** dimensionar workers; prueba de carga antes de producción.
- **Costos:** medir minutos y tokens reales (Twilio + Deepgram + Anthropic + Azure).
- **Cumplimiento:** aviso de asistente virtual + grabación (datos personales Chile).
- **Fallback:** si el servicio de voz cae, un TwiML de respaldo que derive a un asesor.

---

## Resumen de dependencias por fase
| Fase | Necesita |
|---|---|
| 0 | Keys: Anthropic✅, Deepgram, Azure Speech, Twilio; Python; ngrok |
| 1 | Número Twilio (trial sirve) + ngrok |
| 2 | Backend Node + VOICE_SECRET |
| 3 | — (ajustes) |
| 4 | Scope `telephony` en Bitrix + `BITRIX_TELEPHONY_USER_ID` |
| 5 | Número **+56** real + host cloud (Railway/Fly) |
