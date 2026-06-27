# PoC F1 — Criterios de aceptación (§7.4.6)

El PoC se considera **aprobado (Gate M1 → seguir Opción A)** si se cumplen los 3 criterios.
Si falla #2 o #3 → activar **Plan B** (API de ChatApp).

| # | Criterio | Cómo verificar | Resultado |
|---|---|---|---|
| 1 | El bot **recibe** el inbound de ChatApp | Enviar un WhatsApp al número de prueba. En los logs de Railway aparece `INBOUND bot message` con `entity=LINES` y el texto. | ☐ |
| 2 | La **respuesta** del bot llega a WhatsApp | El teléfono de prueba recibe el eco `🤖 (PoC eco) Recibí: "..."`. En logs: `REPLY enviado`. | ☐ |
| 3 | **Precedencia** bot-primero, sin conflicto | El bot responde antes que un operador humano; el bot propio de ChatApp/ChatGPT está **desactivado** y no responde en paralelo. | ☐ |

## Smoke tests previos (F1-T2 / F1-T4)

| Test | Comando | Esperado |
|---|---|---|
| Anthropic (Sonnet 4.6) | `npm run smoke:anthropic` | Imprime respuesta + latencia |
| Bitrix REST (Deals) | `npm run smoke:bitrix` | Imprime cantidad de Deals |
| App arriba | `GET /health` | `{ "ok": true }` |

## Registro de resultados

- Fecha del PoC: ______
- Criterio 1: ☐ OK ☐ Falla — notas: ______
- Criterio 2: ☐ OK ☐ Falla — notas: ______
- Criterio 3: ☐ OK ☐ Falla — notas: ______
- **Decisión M1:** ☐ Seguir Opción A ☐ Activar Plan B (API ChatApp)
