# Módulo de Analítica de Llamadas — Bitrix24 (UA Postgrados)

Módulo embebido en Bitrix24 para visualizar y analizar la telefonía del portal
(llamadas de asesores humanos **y** del agente de voz IA). Se integra a la app existente
sin alterar funcionalidades previas.

---

## 1. Qué se implementó

| Requerimiento | Estado |
|---|---|
| Historial de llamadas (contacto, número, tipo, fecha, duración, asesor, estado, grabación) | ✅ |
| Dashboard de KPIs (totales, contestadas/perdidas, duración prom./total, tasas) | ✅ |
| Análisis por horario (por hora, por día de semana, entrante vs saliente por franja) | ✅ |
| Filtros (rango de fechas, asesor, tipo, estado, teléfono, contacto) | ✅ |
| UI moderna y responsive (tarjetas KPI, tabla paginada/ordenable/buscable, gráficos interactivos) | ✅ |

---

## 2. Fuente de datos

Todo sale de **`voximplant.statistic.get`**, la estadística de telefonía de Bitrix24. Reúne
**todas** las llamadas del portal, incluidas las del agente de voz (Vapi), porque el bot las
registra vía `telephony.externalCall.*`. Así no duplicamos datos ni creamos tablas nuevas:
una sola fuente unificada.

> **Requisito:** el webhook admin (`BITRIX_WEBHOOK_URL`) debe tener el scope **`telephony`**.
> Sin él, la API responde `insufficient_scope` (verificado).

Campos usados: `CALL_TYPE` (1 saliente, 2/3 entrante, 4 callback), `PHONE_NUMBER`,
`CALL_DURATION`, `CALL_START_DATE`, `PORTAL_USER_ID`, `CALL_FAILED_CODE` (estado tipo SIP),
`CALL_RECORD_URL` (grabación), `CRM_ENTITY_TYPE`/`CRM_ENTITY_ID` (contacto/empresa/lead).

Mapa de estado (`CALL_FAILED_CODE`): `200` Contestada · `304` No contestada · `486` Ocupado ·
`603` Rechazada · `408` Sin respuesta · `487` Cancelada · otros → "Código N".

---

## 3. Archivos modificados / nuevos

**Nuevos**
- `src/crm/callStats.ts` — lógica de datos: pagina `voximplant.statistic.get`, resuelve nombres
  (asesor vía `user.get`; contacto/empresa/lead vía `crm.*.list` en lotes de 50), y agrega
  KPIs + series `porHora[24]` y `porDia[7]` separando entrante/saliente.
- `src/routes/calls.ts` — `callsPage` (HTML embebible) y `callsData` (API JSON con filtros).
- `docs/Modulo-Analitica-de-Llamadas.md` — este documento.

**Modificados (aditivos, sin romper lo existente)**
- `src/bitrix/client.ts` — se añadió `callCrmEnvelope` / `callBitrixEnvelope` que devuelven el
  sobre completo (`result` + `next` + `total`) para **paginar**. `callCrm`/`callBitrix` mantienen
  su firma y comportamiento (siguen devolviendo solo `result`).
- `src/bitrix/placement.ts` — se refactorizó a un helper `bindPage()` y se agregó `bindCalls()`
  (nuevo ítem de menú "Analítica de Llamadas"). `bindDashboard()` intacto.
- `src/routes/setup.ts` — `bindCallsManual` (endpoint `/setup/bind-calls`).
- `src/index.ts` — rutas `GET/POST /calls`, `GET /calls/data`, `GET /setup/bind-calls`.

---

## 4. API `GET /calls/data`

Parámetros (querystring, todos opcionales):
`from`, `to` (YYYY-MM-DD) · `userId` (ID de asesor) · `type` (`in`|`out`) ·
`status` (`answered`|`missed`) · `phone` (parcial) · `limit` (máx. llamadas a traer, tope 2000).

Respuesta:
```json
{
  "ok": true,
  "fetched": 320, "total": 320,
  "kpis": { "total":320,"entrantes":180,"salientes":140,"contestadas":250,
            "perdidas":70,"durTotal":48210,"durProm":193,
            "tasaContestadas":78,"tasaPerdidas":22 },
  "porHora": [ { "h":0,"entrantes":1,"salientes":0 }, ... 24 ],
  "porDia":  [ { "d":0,"entrantes":5,"salientes":3 }, ... 7 ],
  "usuarios": [ { "id":42,"nombre":"Ana Pérez" } ],
  "rows": [ { "id","fecha","tipo","telefono","duracion","usuario",
              "estado","contestada","grabacion","contacto" } ]
}
```

---

## 5. Decisiones técnicas (justificación)

- **Reutilizar `voximplant.statistic.get`** en vez de crear tablas: fuente única y siempre
  al día; incluye llamadas del bot y humanas; cero migración de datos.
- **`callCrmEnvelope` nuevo** en vez de tocar `callCrm`: la paginación necesita `next`/`total`,
  que `callCrm` descartaba. Se añadió sin cambiar la firma existente → no rompe nada.
- **Resolución de nombres en lotes** (`@ID` in [50]) y cacheada por request: minimiza llamadas
  a la API (respeta el leaky bucket 2 req/s) y evita el N+1.
- **Tope de rendimiento** (`limit`, default 500, máx 2000): la estadística puede ser enorme
  (~18k leads/mes). Se agrega por páginas de 50 y se corta; la UI avisa si `total > fetched`.
- **Hora/día desde el string ISO** del portal (regex), no `new Date().getHours()`: evita
  corrimientos por el huso del servidor (Railway en UTC).
- **Filtros del lado servidor** (FILTER de Bitrix) para fecha/asesor/tipo/estado/teléfono;
  búsqueda por contacto y orden/paginación de la tabla del lado cliente (rápido, sin recargar).
- **Chart.js por CDN**: el placement es un iframe servido desde Railway (igual que ya carga el
  SDK de Bitrix); permite scripts externos. Gráficos interactivos sin dependencias en el build.

---

## 6. Cómo probar

**Requisito previo:** agregar el scope **`telephony`** al webhook (`BITRIX_WEBHOOK_URL`) en
Bitrix (Desarrolladores → tu webhook entrante → marca "Telefonía" → guardar).

1. **Datos (API):**
   `https://botbitrix24-production.up.railway.app/calls/data?from=2026-06-01&to=2026-07-07`
   → debe devolver `ok:true` con `kpis`, `porHora`, `porDia`, `rows`.
2. **Página:** abre `https://botbitrix24-production.up.railway.app/calls`
   → tarjetas de KPIs, 4 gráficos y la tabla.
3. **Filtros:** cambia fechas / asesor / tipo (Entrante/Saliente) / estado (Contestada/Perdida)
   / teléfono → **Aplicar**. Los KPIs y gráficos se recalculan.
4. **Tabla:** ordena por columna (clic en el encabezado), busca por contacto/teléfono, pagina.
5. **Grabación:** en llamadas con grabación aparece "▶ oír" (link a `CALL_RECORD_URL`).
6. **Dentro de Bitrix (menú):** una vez instalada la app, ejecuta
   `GET /setup/bind-calls` → agrega el ítem "Analítica de Llamadas" al menú izquierdo.

---

## 6b. Modo Postgres (KPIs exactos) — IMPLEMENTADO

Para que los KPIs sean exactos sobre TODO el período (y no una muestra), las llamadas se
**sincronizan a Postgres** (tabla `calls`, espejo de `voximplant.statistic.get`):

- **`src/crm/callSync.ts`** — `syncCalls()` incremental por **marca de agua** (ISO de la última
  llamada guardada, con 1 min de solape); backfill inicial desde `CALLS_SYNC_SINCE` o últimos 30 días.
  Upsert por `id` (sin duplicados). `startCallSync()` = scheduler cada `CALLS_SYNC_MINUTES`.
- **`src/store/db.ts`** — tabla `calls` + `dbUpsertCalls`, `dbCallsWatermarkIso`, `dbCallAnalytics`
  (KPIs, series por hora/día y últimas 1.000 filas, **todo en SQL** con filtros parametrizados).
- **`/calls/data`** usa Postgres si hay datos sincronizados; si no, cae al modo en vivo (muestra).
  El pie de la UI indica el modo (`KPIs exactos` vs `muestra`).

**Activación:**
1. `DATABASE_URL` en Railway (plugin Postgres) — ya presente.
2. Backfill inicial: `GET /setup/sync-calls` (corre en segundo plano) **o** define
   `CALLS_SYNC_MINUTES=15` para que el scheduler sincronice solo cada 15 min.
3. (Opcional) `CALLS_SYNC_SINCE=2026-01-01` para traer histórico más largo en el primer backfill.

> La tabla siempre muestra las **últimas 1.000** filas del rango; los KPIs/gráficos son exactos
> sobre el **total**. Los `CALL_FAILED_CODE` con sufijo ("603-S") se normalizan por código base.

## 7. Mejoras futuras

- **Ranking por asesor** (contestadas, duración media, tasa de pérdida por persona).
- **Métricas por asesor** (ranking de contestadas, duración media, tasa de pérdida por persona).
- **Exportar a CSV/Excel** el historial filtrado.
- **Embudo bot→humano**: cruzar llamadas del agente de voz (por `REST_APP_ID`) vs. asesores.
- **Alertas**: notificar cuando la tasa de pérdida supere un umbral por franja horaria.
- **Costo de telefonía** y **transcripciones** (si se habilitan en Bitrix) como columnas/plots.
- **Cache corta** (p. ej. 60 s) del resultado por combinación de filtros para aliviar la API.
