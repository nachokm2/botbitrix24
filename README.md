# PoC F1 — Agente Comercial Bitrix24 (bot de Open Lines sobre ChatApp)

Prueba de concepto para validar la **Opción A**: un **chatbot de Open Lines** (`imbot` TYPE=O), registrado por una **app local de Bitrix24**, que recibe los mensajes de **WhatsApp que entran por ChatApp** y responde un **eco** (que debe llegar de vuelta a WhatsApp).

Stack: **Node.js + TypeScript**, hosting en **Railway**, IA por **API de Anthropic** (smoke test). Sin Vibecode.

> Objetivo: aprobar los **3 criterios de §7.4.6** (ver [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md)) → **Gate M1**.

---

## 1. Qué hace

```
WhatsApp → ChatApp → Open Lines (Bitrix24) → [bot] → POST /events/bot/message (este app)
                                                          │
                                          imbot.message.add (eco) → ChatApp → WhatsApp
```

Endpoints:

| Ruta | Uso |
|---|---|
| `GET /health` | Healthcheck (Railway) |
| `ALL /install` | Instalación del app local: guarda auth + registra el bot |
| `POST /events/bot/message` | Recibe `ONIMBOTMESSAGEADD` y responde el eco |
| `POST /events/bot/welcome` · `/events/bot/delete` | Eventos de ciclo de vida del bot |
| `GET /setup/register-bot` · `/setup/unregister-bot` | Registro/limpieza manual del bot |

---

## 2. Requisitos

- Node.js 18+
- Portal **Bitrix24 de pruebas** con **plan comercial** (REST + Open Channels + eventos)
- **ChatApp** instalado y conectado a un número de WhatsApp de prueba
- **API key de Anthropic** (BYOK)
- Cuenta de **Railway** (o un túnel para probar en local)

---

## 3. Instalación local

```bash
cd poc-agente-bitrix24
npm install
cp .env.example .env      # completa ANTHROPIC_API_KEY y, al final, BASE_URL
```

Smoke test de Anthropic (no requiere Bitrix):

```bash
npm run smoke:anthropic
```

Para correr el servidor en local necesitas una **URL pública** (Bitrix llama por HTTPS). Usa un túnel:

```bash
# Opción A: Cloudflare (sin registro)
npx cloudflared tunnel --url http://localhost:3000
# Opción B: ngrok
npx ngrok http 3000
```

Copia la URL HTTPS que te dé el túnel a `BASE_URL` en `.env` y levanta el server:

```bash
npm run dev
```

---

## 4. Deploy en Railway (recomendado)

1. Sube esta carpeta a un repo Git y conéctalo en **Railway → New Project → Deploy from GitHub**
   (o `railway up` con la CLI).
2. En **Variables** define:
   - `ANTHROPIC_API_KEY`
   - `ANTHROPIC_MODEL=claude-sonnet-4-6`
   - `BOT_CODE=poc_agente_postgrados`
   - `BASE_URL` = el dominio público que te asigna Railway (ej. `https://poc-...up.railway.app`) — **sin slash final**
   - `BITRIX_CLIENT_ID` y `BITRIX_CLIENT_SECRET` (del registro de la app local) — para renovar el token automáticamente
3. Railway expone el puerto vía `PORT` automáticamente. Healthcheck: `/health`.
4. Verifica: abre `https://TU-APP.up.railway.app/health` → `{ "ok": true }`.

> El filesystem de Railway es efímero; no afecta al PoC porque el bot usa el `auth` que llega en cada evento.

---

## 5. Registrar la app local en Bitrix24

En el portal: **Aplicaciones → Recursos para desarrolladores → Otro → Aplicación local**
(*Applications → Developer resources → Other → Local application*). Crea una con:

- **Ruta del controlador / Handler URL:** `https://TU-APP.up.railway.app/install`
- **Ruta de instalación inicial:** `https://TU-APP.up.railway.app/install`
- **Permisos (scopes):** `crm`, `imbot`, `imopenlines`, `im`, `user`
- Marca que usa API (con interfaz si lo pide).

Guarda y pulsa **Instalar**. Bitrix llamará a `/install`, que **registra el bot** automáticamente
(verás una página de confirmación con el `BOT_ID`, y en los logs `install: bot registrado`).

> Si la instalación no disparó el registro, llama manualmente a `GET /setup/register-bot`.

Smoke test del CRM (tras instalar):

```bash
npm run smoke:bitrix          # usa el auth OAuth almacenado
# o, para probar sin OAuth, define BITRIX_WEBHOOK_URL en .env y corre lo mismo
```

---

## 6. Configurar el canal de ChatApp (clave para el Criterio 3)

En el **canal abierto de ChatApp** (Contact Center):

1. Activa el **procesamiento automático por chatbot** y selecciona **"PoC Asistente Postgrados"** como primer responder.
2. **Desactiva el bot propio de ChatApp** (su *Bot Designer* y la auto-respuesta con ChatGPT) para que no compita.
3. Asegura que la cola derive a operadores **después** del bot.

---

## 7. Ejecutar la prueba (los 3 criterios)

1. Desde un teléfono, envía un WhatsApp al número de prueba conectado a ChatApp.
2. Observa los **logs de Railway**:
   - `INBOUND bot message ... entity=LINES ...` → **Criterio 1 ✅**
   - `REPLY enviado ...` y el teléfono recibe el eco → **Criterio 2 ✅**
3. Confirma que **el bot respondió antes** que cualquier operador y que ChatApp no respondió en paralelo → **Criterio 3 ✅**

Registra los resultados en [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) y toma la **decisión M1**.

---

## 8. Si falla (Plan B)

Si el Criterio 2 o 3 no se cumple (el bot no intercepta, o ChatApp no relaya la respuesta del bot),
se pivota al **Plan B**: integrar por la **API de ChatApp** (webhook `message` para entrante +
`messages/text` / `messages/template` para saliente). El `agentLoop` y la lógica del agente se reutilizan;
solo cambia la capa de transporte.

---

## 9. Estructura

```
poc-agente-bitrix24/
├── src/
│   ├── index.ts              # servidor express + rutas
│   ├── config.ts             # variables de entorno
│   ├── log.ts                # logger JSON
│   ├── store.ts              # auth + botId (persistencia mínima)
│   ├── bitrix/
│   │   ├── client.ts         # callBitrix (OAuth, throttle) + callWebhook
│   │   └── auth.ts           # extractAuth (instalación + eventos)
│   ├── bot/register.ts       # imbot.register / unregister
│   └── routes/
│       ├── install.ts        # /install
│       ├── botEvents.ts      # /events/bot/* (eco)
│       └── setup.ts          # registro/limpieza manual
├── scripts/
│   ├── smoke-anthropic.ts    # F1-T4
│   └── smoke-bitrix.ts       # F1-T2
├── docs/ACCEPTANCE.md        # criterios §7.4.6
├── railway.json · .env.example · tsconfig.json · package.json
```

## 11. Persistencia y Observabilidad

- **KV (Redis)**: memoria de conversación, estado de sesión, tokens e idempotencia de eventos. Si no hay `REDIS_URL`, usa memoria en proceso (se pierde al reiniciar).
- **Postgres**: auditoría de acciones del agente (tabla `audit_log`). Si no hay `DATABASE_URL`, la auditoría queda solo en logs.
- **En Railway**: añade los plugins **Redis** y **Postgres** (New → Database). Railway crea `REDIS_URL` y `DATABASE_URL` automáticamente; el app los toma en el próximo deploy.
- **Endpoints de observabilidad**:
  - `GET /metrics` → JSON con contadores (inbound, reply, conversations, tool:*, escalations, errors) + latencia LLM (avg/p95) + backend KV/DB.
  - `GET /stats` → panel HTML con métricas + auditoría reciente.

## 10. Notas

- **No** subas `.env` (ya está en `.gitignore`).
- Limpieza: `GET /setup/unregister-bot` desregistra el bot del portal.
- Scopes mínimos por diseño (sin `imconnector`: el conector lo gestiona ChatApp).
- Este PoC valida viabilidad; el agente real (agentLoop con tool-calling, memoria, guardrails) es la Fase 6.
