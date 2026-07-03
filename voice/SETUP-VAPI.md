# Guía de configuración — Agente de voz con Vapi

Paso a paso para dejar operativo el agente de voz (Vapi + Claude + nuestro backend + Bitrix24).
Backend ya desplegado: `https://botbitrix24-production.up.railway.app`

> Consejo: puedes **validar el asistente sin número** usando el botón "Talk to Assistant" del dashboard de Vapi. Así pruebas la conversación y las herramientas antes de tener el número +56 aprobado en Twilio.

---

## 0. Qué necesitas
- Cuenta en **Vapi** (vapi.ai).
- (Para llamadas reales) un **número de teléfono**: al inicio uno de prueba de Vapi (US) para testear, y luego el **+56 de Twilio** importado cuando el bundle regulatorio esté aprobado.
- Acceso a **Railway** (variables de entorno del backend).
- (Para registrar llamadas en el CRM) el scope **`telephony`** en la app de Bitrix — se puede dejar para el final.

---

## 1. Crear cuenta y API key
1. Entra a **vapi.ai** → *Sign up* → verifica tu correo.
2. En el dashboard, ve a **API Keys**.
3. Copia la **Private Key** → será `VAPI_API_KEY` (la usamos para llamadas salientes).

---

## 2. Crear el asistente
Dashboard → **Assistants** → **Create Assistant** (parte de "Blank" / en blanco). Configura:

**a) Model (cerebro)**
- Provider: **Anthropic**
- Model: **Claude Haiku** (equilibrado: rápido y económico). Si quieres más calidad, un Claude Sonnet.
- **System Prompt**: pega el que está en [`vapi-assistant.json`](vapi-assistant.json) (campo `model.messages[0].content`). Resumen: asistente de voz de Postgrados UA, frases cortas, sin URLs, flujo nombre→correo→teléfono, usa herramientas, deriva a asesor.

**b) Transcriber (STT / escucha)**
- Provider: **Deepgram**
- Language: **Spanish (es)**

**c) Voice (TTS / voz)**
- Provider: **Azure**
- Voice: **es-CL** (Catalina o Lorenzo). *[Verifica en el buscador de voces que aparezca es-CL; si no, usa una voz es-MX/es-ES o prueba ElevenLabs.]*

**d) First Message (saludo)**
- `Hola, le saluda el asistente de Postgrados de la Universidad Autónoma de Chile. ¿En qué le puedo ayudar?`

Guarda. Copia el **Assistant ID** → será `VAPI_ASSISTANT_ID`.

---

## 3. Conectar el asistente con nuestro backend (herramientas + eventos)

**a) Server URL (webhook)**
En el asistente, sección **Messaging → Server URL** (o "Advanced → Server"):
- URL: `https://botbitrix24-production.up.railway.app/vapi/events`
- Secret: inventa un valor (ej. una cadena larga aleatoria) → será `VAPI_SECRET` (lo pondrás igual en Railway).
- Server Messages: activa **tool-calls** y **end-of-call-report** (y status-update si está).

**b) Tools (herramientas)** — solo **2** (el catálogo va por Base de conocimiento, ver paso 2.5)
Agrega 2 herramientas de tipo **Function** (Tools → Create Tool → Function), con su mensaje **Request Start**:
- `registrar_interes_crm` (nombre, apellido, email, telefono, programa_interes, comentario) — request-start: "Perfecto, lo anoto…"
- `transferir_a_asesor` (motivo) — request-start: "Le conecto con un asesor, un momento…"

Parámetros exactos en [`vapi-assistant.json`](vapi-assistant.json) → `model.tools`. Como el asistente ya tiene el **Server URL**, Vapi enviará los `tool-calls` ahí y nuestro backend responde.

## 2.5. Base de conocimiento (catálogo de programas)
En vez de consultar el catálogo por herramienta (más lento), el asistente responde desde una **Base de conocimiento**:
1. Genera/actualiza el archivo: `npx tsx scripts/gen-kb.mts` → crea [`voice/base-conocimiento-programas.md`](base-conocimiento-programas.md) (184 programas con arancel, matrícula, requisitos, descripción).
2. En Vapi: **Knowledge Base / Files** → **Upload** ese `.md` → crea una Knowledge Base con ese archivo.
3. En el asistente → **Model → Knowledge Base** → asigna la que creaste.
4. El prompt ya instruye responder SOLO desde la base y derivar a un asesor si un dato no aparece (nunca inventar precios).
> Cuando cambie el catálogo, corre de nuevo el script y vuelve a subir el archivo.

> **Alternativa rápida (1 comando):** en vez de hacerlo a mano, crea el asistente por API con nuestra plantilla:
> ```bash
> curl -X POST https://api.vapi.ai/assistant \
>   -H "Authorization: Bearer TU_VAPI_API_KEY" \
>   -H "Content-Type: application/json" \
>   -d @vapi-assistant.json
> ```
> Antes reemplaza en el JSON `<BACKEND_BASE>` por `https://botbitrix24-production.up.railway.app` y `<VAPI_SECRET>` por tu secreto. La respuesta trae el `id` (= `VAPI_ASSISTANT_ID`). *(Si algún campo cambió en la API de Vapi, ajústalo según docs.vapi.ai.)*

---

## 4. Número de teléfono

**Opción A — Probar ya (número de prueba de Vapi, US):**
Dashboard → **Phone Numbers** → *Create* (Vapi da un número US gratis) → asígnale tu asistente. Sirve para testear (o usa "Talk to Assistant" sin número).

**Opción B — Producción (+56 de Twilio):**
Cuando el bundle regulatorio de Twilio esté aprobado y tengas el número:
Dashboard → **Phone Numbers** → **Import** → **Twilio** → ingresa tu **Account SID**, **Auth Token** y el número **+56…** → asígnale el asistente.
Copia el **Phone Number ID** → será `VAPI_PHONE_NUMBER_ID`.

---

## 5. Variables en Railway
En el servicio del backend, agrega/confirma:

| Variable | Valor |
|---|---|
| `VAPI_API_KEY` | Private Key de Vapi (paso 1) |
| `VAPI_ASSISTANT_ID` | ID del asistente (paso 2) |
| `VAPI_PHONE_NUMBER_ID` | ID del número (paso 4B) — para salientes |
| `VAPI_SECRET` | El mismo secreto del Server URL (paso 3a) |
| `BITRIX_TELEPHONY_USER_ID` | ID del usuario Bitrix "dueño" de las llamadas (para el CRM) |
| `VOICE_TRANSFER_FALLBACK` | Número/SIP del asesor por defecto para derivar (opcional) |

Verifica en: `https://botbitrix24-production.up.railway.app/debug/config` → bloque `voz` (deben salir en `true`).

---

## 6. Probar

**a) Entrante:** llama al número asignado (o usa "Talk to Assistant"). El bot debe saludar en es-CL, responder de programas (tool `consultar_programas`/`detalle_programa`) y pedir tus datos.

**b) Saliente:** con las variables puestas:
```bash
curl -X POST https://botbitrix24-production.up.railway.app/voice/outbound \
  -H "Content-Type: application/json" \
  -d '{"phone":"+569XXXXXXXX"}'
```
*(En cuenta Twilio de prueba solo se puede llamar a números verificados.)*

**c) CRM:** al colgar, el backend registra la llamada en Bitrix (`end-of-call-report` → `externalCall.*`) con grabación y transcripción. Requiere el scope **`telephony`** en la app (paso 7).

---

## 7. Registro en el CRM de Bitrix (para el final)
Para que las llamadas queden en el CRM:
1. En la app local de Bitrix, agrega el scope **`telephony`** (como hiciste con `placement`/`user`) y **reinstala**.
2. Define `BITRIX_TELEPHONY_USER_ID` en Railway.
Listo: cada llamada crea/vincula lead o contacto, con duración, grabación y transcripción.

---

## Checklist rápido
- [ ] Cuenta Vapi + Private API key
- [ ] Asistente creado (Claude Haiku + Deepgram es + Azure es-CL + prompt)
- [ ] Server URL → `/vapi/events` + secret; herramientas agregadas
- [ ] Número (prueba US o +56 Twilio importado) asignado al asistente
- [ ] Variables `VAPI_*` en Railway (verificado en `/debug/config`)
- [ ] Prueba entrante (o "Talk to Assistant") OK
- [ ] (Final) scope `telephony` en Bitrix + `BITRIX_TELEPHONY_USER_ID` → llamadas en el CRM
