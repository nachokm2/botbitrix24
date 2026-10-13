# Auditoría del agente de Carver — octubre 2026

Informe de cierre de la auditoría, corrección y prueba del agente de WhatsApp de Carver University
(servicio `botcarver`, mismo código que Postgrados con `MARCA=carver`). Fecha de corte: 2026-10-13.

> Estados de cada hallazgo: `CORREGIDO`, `PARCIAL`, `PENDIENTE`, `BLOQUEADO`.
> Estados de implementación (no son equivalentes): **Implementada** → **Probada en entorno aislado**
> (tests con CRM simulado) → **Validada mediante integración** (contra servicios reales, solo lectura)
> → **Verificada en producción** (observada en el servicio desplegado).

---

## 1. Resumen ejecutivo

- Los 11 hallazgos tienen causa raíz identificada con evidencia de producción (logs de Railway del
  10 al 13 de octubre, historial de chats y fichas de Bitrix24, consultas de solo lectura).
- Ocho de las once causas estaban en el **código o los datos**, no en el modelo. Ejemplos: el fee de
  titulación viajaba en *toda* cotización; la memoria vencía a las 6 h y el segundo recordatorio, a las
  10 h, se descartaba en silencio; el texto del seguimiento tenía la identidad de Postgrados escrita a
  mano. Por eso la corrección es principalmente lógica de negocio y no ajustes de prompt.
- Las reglas comerciales críticas ahora se **imponen en código** (`src/core/guardRespuesta.ts`): fee
  solo ante pregunta explícita, ningún enlace sin verificar, sin markdown, sin repeticiones y sin afirmar
  registros que fallaron. El prompt sigue orientando, pero ya no es la única barrera.
- Conversaciones de referencia (12 escenarios, mismo modelo y mismas condiciones):
  **4/12 → 12/12 casos aprobados; cumplimiento de reglas 91,0 % → 100 %** (ver §6).
- Tests automatizados: **448 → 522**, todos aprobados; chequeo de tipos limpio.
- Postgrados, que se despliega desde el mismo repositorio, queda **sin cambios de comportamiento**: lo
  que ve su modelo (prompts y esquemas de herramientas de sus 5 canales) es idéntico byte a byte
  (huella SHA-256 antes y después).
- Pendiente fuera del alcance técnico: confirmar la identidad oficial y aplicarla en Bitrix, contar
  con una fuente de **PDF directo** para los brochures, y cargar y validar los cuatro contenidos
  comerciales (§8).

## 2. Arquitectura encontrada y componentes afectados

| Pieza | Qué es | Dónde |
|---|---|---|
| Entrada | Bot de Open Lines (imbot `TYPE=O`) que recibe `ONIMBOTMESSAGEADD` vía ChatApp (WhatsApp) | `src/routes/botEvents.ts` |
| Motor | Bucle de Claude con herramientas (`claude-sonnet-4-6`; clasificador `claude-haiku-4-5`), máx. 5 pasos | `src/ai/agentLoop.ts` |
| Instrucciones | Prompt por marca + bloque de objeciones/precios + bloques por turno (identidad, datos, idioma) | `src/ai/prompt.ts`, `src/core/promptObjeciones.ts` |
| Herramientas | catálogo, detalle, precio, registro CRM, derivación (+3 nuevas) | `src/ai/tools.ts`, `src/ai/toolRunner.ts` |
| Memoria | Redis: historial (6 h, 24 turnos), sesión (6 h); CRM: notas de timeline; historial del chat al entrar | `src/ai/memory.ts`, `src/session.ts`, `src/crm/chat.ts` |
| CRM | Bitrix24 compartido (`uachile.bitrix24.es`); embudos propios 73 «Carver» y 135 «Carver CU»; punto de entrada único `BITRIX_DERIVAR_A=1313` | `src/crm/*` |
| Seguimiento | Colas ZSET en Redis: recordatorio a 3 h, derivación con tarea a 4 h, último recordatorio a 10 h; ventana 9–21 h de Chile | `src/ai/seguimiento.ts` |
| Trazabilidad | `audit_log` en Postgres, métricas, logs de Railway, revisión diaria | `src/obs/*`, `src/store/db.ts` |
| Despliegue | Railway, autodespliegue desde `main` de GitHub: **dos servicios** (`botbitrix24` = Postgrados, `botcarver` = Carver), cada uno con su Redis y su Postgres | `railway.json` |

Embudos de Bitrix verificados (solo lectura): 73 «Carver», 135 «Carver CU», 89 «Cobranza Carver»,
91 «Carver Colombia», **107 «Advisor Carver»** (acompañamiento de estudiantes, 1.028 fichas) y 137
«Testeos». En 73 y 135 existe la etapa «Noocs» y la etapa ganada es «Matriculado».
Equipo de Carver en la estructura: departamentos 193 «Carver», 509 «Carver V1» y 511 «Carver V2».

## 3. Matriz de hallazgos y causas raíz

| ID | Prio. | Observación | Evidencia reproducible | Causa raíz (confirmada) | Origen | Corrección | Prueba de aceptación | Estado |
|---|---|---|---|---|---|---|---|---|
| H01 | P1 | Identidad «Sofía · Carver» incoherente | El bot está registrado como «Sofía · Carver» y los clientes le escriben «Gracias, Sofía»; el mismo bot, hablando como el asesor Ignacio, dice «confírmelo con Ignacio» (chat1501721); el seguimiento se generaba como «Sofía, asesora de Postgrados de la Universidad Autónoma de Chile» (`seguimiento.ts:52`) | Tres fuentes de identidad sin unificar (nombre registrado, asesor adoptado y respaldo «Sofía»), más textos de Postgrados fijos en seguimiento, resumen y scoring | Código + configuración | Identidad institucional sin persona inventada; el bot solo adopta a un asesor válido de una ficha propia; derivación en primera persona; regla contra hablar de sí en tercera persona; seguimiento, resumen y scoring toman la marca | `carverAuditoria`, `carverCrm` (identidad), `carverSeguimiento`; regresión R02, R09, R10 | **PARCIAL**: falta confirmar la identidad oficial y aplicar el nombre en Bitrix (§11) |
| H02 | P1 | El brochure no era un PDF válido | 6 envíos (10–12 oct) de enlaces `uachile.bitrix24.es/doc/…`: visor HTML (`text/html`), alojado en el portal de **otra institución**, entregado sin verificar; la descarga anónima devuelve 403 | El catálogo guarda enlaces de visor y el bot los copiaba desde `detalle_programa` sin comprobar nada | Datos + código | Herramienta `obtener_brochure`: comprueba estado HTTP, formato (PDF o visor de PDF) y que el archivo corresponda al programa; caché; si falla, no entrega ningún enlace y registra la solicitud; el guardián borra enlaces que no vengan de una herramienta | `carverAuditoria` (8 casos), `carverGuardianMotor`; integración real **16/16 verificados**; regresión R05 | **PARCIAL**: accesible y verificado, pero es un visor y no un archivo PDF directo (§8, §13) |
| H03 | P2 | Inicio de conversación con preguntas no pertinentes | El objetivo 1 pedía «área de interés, modalidad y situación» (todo Carver es en línea); línea base: 3 preguntas en un mensaje (R02) | Prompt | Modelo (instrucción) | Inicio progresivo y contextual, una pregunta por mensaje y sin preguntar modalidad | Regresión R01, R02, R10 (`preguntas_por_respuesta`, `no_pregunta_modalidad`) | CORREGIDO |
| H04 | P2 | Pedía de nuevo datos que ya existían | Los datos conocidos solo se leían del contacto, no del lead; el prompt pedía el teléfono con código de país aunque el cliente escribe por WhatsApp | Código + prompt | Código | Datos conocidos también desde el lead; confirmar (enmascarado) en lugar de pedir; el WhatsApp ya es un teléfono de contacto; ante una contradicción vale el dato nuevo | `marcaCarver` (bloque de datos); regresión R06 | CORREGIDO |
| H05 | P1 | Mencionaba el fee de titulación sin que lo preguntaran | Producción: «…y USD 125 de titulación al finalizar» en respuestas a «Precio y contenido» (chat1501721 ×2, chat1501463); línea base: R01, R04 y R07 fallan | La herramienta de precios devolvía `costosAdicionales` en **toda** cotización y el prompt decía «debes mencionarlos si preguntan por el total» | Datos/código + prompt | El código decide con el mensaje del cliente si incluir esos costos; el guardián borra la frase si nadie preguntó; nueva regla en el prompt | `guardRespuesta`, `carverCrm`, `marcaCarver`; regresión R01, R04, R07 | CORREGIDO |
| H06 | P1 | Ofrecía NOOCs | 22 cursos en la oferta; el prompt decía «CURSOS CORTOS: son GRATIS»; línea base R12 ofreció un curso gratis | Configuración de marca + prompt | Configuración | Nuevo módulo `oferta.ts`: búsqueda, detalle, precio y brochure excluyen lo no comercializable; el esquema solo ofrece licenciatura/maestría; **el catálogo conserva los 22 cursos** (historia) | `carverAuditoria` (oferta), `marcaCarver`; regresión R12 | CORREGIDO |
| H07 | P1 | Derivación defectuosa | El bot volvió a responder 12 h después de que un asesor tomara el chat (chat1501721) y 7 min después de otro traspaso (chat1502211); al derivar anunciaba «el asesor X lo contactará» siendo X él mismo; con contacto sin ficha buscaba la negociación más reciente de **cualquier** embudo | El estado de traspaso vivía 6 h; la búsqueda por contacto no filtraba embudo; mensajes de derivación en tercera persona | Código | Traspaso recordado por **sesión de Open Lines**; filtro de embudos propios; derivación en primera persona; autoescalada por el mismo camino de derivación; nota en la ficha y auditoría de cada decisión | `carverTraspaso`, `carverCrm` (derivación), `autoescaladoIdempotente`; regresión R09 | CORREGIDO (verificación en producción pendiente, §11) |
| H08 | P1 | Dos intentos de contacto: ¿por qué? | Configuración vigente: 3 h / 4 h (tarea) / 10 h, ventana 9–21 h. Logs 10–13 oct: ~100 primeros recordatorios, **0 segundos**, 56 derivaciones por silencio, 1 error de envío | (a) **Configuración**: cada respuesta del bot rearma la secuencia; dos recordatorios el mismo día = el cliente respondió entre ambos (chat1501721: 15:47 y 18:57 UTC). (b) **Fallo de ejecución**: el segundo recordatorio nunca se envió (memoria a 6 h < plazo de 10 h → descarte silencioso). (c) **Condiciones de detención**: humano a cargo, fuera de horario (se reprograma), sin conversación (silencioso) | Código + configuración | Instantánea de la conversación para generar el recordatorio; omisiones auditadas con su motivo; ventana de 24 h de WhatsApp; tope de 2 por día; respeto del traspaso; métricas programado / ejecutado / entregado a Bitrix / respondido; identidad de la marca | `carverSeguimiento` (8 casos), `seguimiento` | CORREGIDO (la secuencia en sí debe aprobarla el negocio, §13) |
| H09 | P1 | Leads asignados a ejecutivos ajenos a Carver | Al derivar se respetaba a cualquier «asesor vigente» sin mirar su equipo; la identidad adoptaba al responsable de cualquier ficha enlazada, incluso de otro embudo | Falta de la noción de **equipo** | Código | `equipo.ts`: departamentos 193/509/511 + punto de entrada; un responsable de otro equipo no conserva el caso, el punto de entrada lo recibe con nota del responsable anterior; **no se reasigna nada histórico** | `carverCrm` (4 casos de identidad y 4 de derivación), `carverAuditoria` (equipo) | CORREGIDO |
| H10 | P1 | Estudiantes matriculados sin flujo propio | Recibían el flujo de venta; línea base R08 sin Advisor | No existía el flujo | Código | `consultar_estado_estudiante`: matrícula por embudo 107 o etapa «Matriculado»; correo de la Advisor **solo** si es persona activa del equipo con correo `@carver.university`; tarea a la Advisor sin tocar la ficha comercial | `carverCrm` (7 casos); regresión R08 | CORREGIDO (validación en producción pendiente) |
| H11 | P2 | Repeticiones y mensajes extensos | «Por tu interés, te conecto con un asesor…» enviado **4 veces** al mismo cliente; respuestas de 700+ caracteres con negritas | La autoescalada guardaba su marca solo si el traspaso funcionaba (Bitrix lo rechazaba) + el modelo | Código + modelo | Autoescalada idempotente; en Carver sin mensaje fijo (contradecía la identidad); guardián: markdown, repetición y condensación segura (solo si conserva montos y enlaces) | `autoescaladoIdempotente`, `guardRespuesta`, `carverGuardianMotor`; regresión R07 | CORREGIDO |

### Hallazgos adicionales

| ID | Prio. | Hallazgo | Estado |
|---|---|---|---|
| N01 | **P0** | La suite de regresión intentaba aislarse de Redis y Postgres después de los `import` (ESM los evalúa antes): con el `.env` de trabajo habría escrito historiales y auditoría de prueba **en la base de producción de Postgrados**. Corregido con `scripts/aislar-regresion.ts` y una verificación que aborta. | CORREGIDO |
| N02 | P1 | Con el CRM caído, el bot afirmaba «quedará registrado» (detectado en la primera corrida DESPUÉS). Ahora la herramienta lo advierte y el guardián elimina la afirmación. | CORREGIDO |
| N03 | P2 | **Contradicción en los datos comerciales**: «matrícula regular USD 150» frente a «cuota de inscripción USD 150 no reembolsable». El bot llegó a cotizar «contado USD 900 + inscripción USD 150 = USD 1.050», aunque la planilla dice que el contado no lleva matrícula. Mitigado (esos costos solo ante pregunta explícita), pero el dato debe aclararlo comercial. | PENDIENTE (negocio) |
| N04 | P2 | El punto de entrada (usuario 1313) pertenece al departamento 49 «Diplomados Internacionales», fuera del árbol de Carver. Se mantiene como del equipo por configuración explícita. | PENDIENTE (confirmación) |
| N05 | P3 | Postgrados tiene los mismos fallos latentes de seguimiento (el segundo recordatorio y los recordatorios nocturnos se pierden). Se dejaron **desactivados por defecto** para no cambiar su comportamiento sin aprobación. | PENDIENTE (decisión) |
| N06 | P3 | Un asesor informó por chat una fecha de inicio que no figura en ninguna fuente verificable. | Ver §8 |

## 4. Cambios realizados por archivo

| Archivo | Cambio |
|---|---|
| `src/marca.ts` | Identidad institucional de Carver (configurable con `CARVER_NOMBRE_INSTITUCIONAL`, `BOT_NOMBRE_REGISTRO`, `BOT_CARGO`, `CARVER_PRESENTACION_SIN_ASESOR`); oferta sin cursos; flags de las nuevas reglas (todas apagadas en Postgrados) |
| `src/config.ts` | Equipo (departamentos/usuarios), embudo y etapas de estudiantes, dominio de correo oficial, datos desde el lead, instantánea y tope del seguimiento; el segundo recordatorio queda apagado por defecto en Postgrados |
| `src/core/guardRespuesta.ts` (nuevo) | Reglas impuestas en código sobre la respuesta |
| `src/core/brochures.ts` (nuevo) | Verificación de brochures |
| `src/core/oferta.ts` (nuevo) | Oferta comercial autorizada |
| `src/core/conocimientoComercial.ts` + `data/carver/conocimiento-comercial.json` (nuevos) | Base de conocimiento verificable |
| `src/crm/equipo.ts`, `src/crm/estudiantes.ts` (nuevos) | Equipo de la marca; estudiantes y su Advisor |
| `src/crm/directory.ts` | Departamentos del usuario; identidad solo de asesor válido y ficha propia; datos conocidos desde el lead |
| `src/crm/asignacionAsesores.ts` | Vigencia con equipo, filtro de embudo, nota y auditoría de cada derivación |
| `src/ai/agentLoop.ts` | Guardián y condensación; historial = lo enviado; bloque de datos que confirma; regla de tercera persona; mensajes de reserva con «usted» |
| `src/ai/toolRunner.ts`, `src/ai/tools.ts`, `src/core/channel.ts` | 3 herramientas nuevas (solo Carver), fee decidido por código, derivación de estudiantes, derivación en primera persona |
| `src/core/catalogTool.ts`, `src/core/condicionesCarver.ts`, `src/core/condicionesComerciales.ts` | Filtro de oferta; costos adicionales solo ante pregunta; sin enlace de brochure sin verificar |
| `src/ai/prompt.ts`, `src/core/promptObjeciones.ts` | Reglas de Carver (inicio, datos, fee, NOOC, brochure, estudiantes, brevedad). El texto de Postgrados no cambia |
| `src/ai/seguimiento.ts` | Identidad de marca, instantánea, ventana de 24 h, tope, traspaso, métricas por estado |
| `src/ai/scoring.ts` | Autoescalada idempotente; en Carver deriva sin mensaje fijo |
| `src/routes/botEvents.ts`, `src/session.ts` | Traspaso por sesión de Open Lines; registro de respuesta a recordatorios |
| `src/ai/briefing.ts`, `src/bitrix/types.ts` | Resumen con la marca correcta; tipo `UF_DEPARTMENT` |
| `src/ai/regresion.ts`, `src/ai/regresion.casos.ts`, `scripts/regresion.ts`, `scripts/aislar-regresion.ts` | 11 comprobaciones nuevas, 12 conversaciones de referencia, métricas, aislamiento seguro |
| `scripts/verificar-brochures.ts`, `scripts/reevaluar-regresion.ts` (nuevos) | Verificación real de los brochures (solo lectura); reevaluación de corridas guardadas con las comprobaciones vigentes |
| `test/*` | 7 archivos nuevos y 4 actualizados a las reglas nuevas |

## 5. Evidencia de las pruebas

| Tipo | Resultado | Naturaleza |
|---|---|---|
| Chequeo de tipos (`tsc --noEmit`) | sin errores | estático |
| Unitarias + integración simulada (`npm test`) | **522/522** (antes 448/448) | aislado: Bitrix, Redis y modelo simulados |
| Contratos de herramienta (esquemas que ve el modelo) | Postgrados: huella idéntica en 5 canales | estático |
| Conversaciones de referencia (`scripts/regresion.ts`) | 12/12 (antes 4/12) | **modelo real**, CRM simulado |
| Brochures (`scripts/verificar-brochures.ts`) | 16/16 accesibles y correspondientes | **integración real**, solo lectura |
| Bitrix24 (embudos, etapas, departamentos, usuarios, formato de sesión) | verificado | **integración real**, solo lectura |

Ninguna prueba escribió en Bitrix, WhatsApp, Redis ni Postgres reales.

## 6. Indicadores antes y después

Conversaciones de referencia: 12 escenarios, 20 respuestas, `claude-sonnet-4-6`, una corrida por
estado, CRM simulado.

| Indicador | Antes | Después | Objetivo |
|---|---|---|---|
| Casos aprobados | 4/12 | **12/12** | — |
| Cumplimiento de reglas (comprobaciones) | 111/122 (91,0 %) | **122/122 (100 %)** | 100 % |
| Menciones espontáneas del fee | 3 casos (R01, R04, R07) | **0** | 0 |
| Ofertas de NOOC | 1 (R12) | **0** | 0 |
| Brochure válido y verificado | 0/1 | **1/1** (verificado en el turno) | 100 % |
| Identidad consistente («Sofía» o tercera persona) | 10/12 (fallan R02, R10) | **12/12** | 100 % |
| Estudiante con su Advisor | 0/1 | **1/1** | 100 % |
| Confirmación de datos (no los vuelve a pedir) | 1/1 | **1/1** (y deriva sin pedir confirmación previa) | 100 % |
| Largo mediano de respuesta | 440 caracteres | 395 caracteres | — |
| Largo P90 / máximo | 674 / 721 | 527 / 560 | — |
| Frecuencia de repetición (oraciones) | 1,1 % | 0 % | — |
| Preguntas innecesarias (más de 1 por mensaje) | 6 | 0 | — |

Corridas DESPUÉS, todas con el mismo modelo y los mismos 12 casos (se informan todas, no solo la mejor):

| Corrida | Resultado | Qué reveló |
|---|---|---|
| 1 | 12/12 | La revisión **cualitativa** detectó dos defectos que las comprobaciones no cubrían: afirmar un registro con el CRM caído (R11) y, hablando como el asesor, remitir a «un asesor» (R09). Se corrigió el código y se endurecieron las comprobaciones. |
| 2 | 12/12 | Persistía «Quedé con sus datos anotados» (R11), y en la regla del guardián `` no reconocía letras con tilde. Corregido. |
| 3 | 11/12 | **Regresión introducida por la auditoría**: el bloque de datos conocidos hizo que el bot confirmara el correo ANTES de derivar a quien pidió que lo contactaran (R06). Corregido: confirmar nunca retrasa una derivación. |
| 4 (oficial) | **12/12** | Código final. R06 se repitió 3 veces más: 3/3. |

La línea base también se reevaluó con las comprobaciones finales, sobre sus transcripciones guardadas
(`scripts/reevaluar-regresion.ts`, sin volver a llamar al modelo). Resultado idéntico, 4/12 y 111/122,
así que la comparación usa exactamente las mismas reglas.

Lectura correcta de estas cifras: el tamaño de la muestra es pequeño (12 casos) y el modelo no es
determinista, así que muestran **dirección y cumplimiento de reglas**, no una tasa de producción. Que
las respuestas sean más cortas no se cuenta como mejora por sí sola: se mide junto a exactitud y
resolución. No hay línea base de producción para las métricas de seguimiento por estado (programado,
ejecutado, entregado, respondido), porque esos eventos no se registraban: empiezan a medirse con este
despliegue. «Entregado» significa aceptado por Bitrix (`imbot.message.add`); la entrega en el teléfono
la confirma el conector de WhatsApp y no vuelve por esta vía.

## 7. Estado de los 11 problemas

| # | Problema | Estado | Implementación |
|---|---|---|---|
| 1 | Identidad unificada | **PARCIAL** | Probada en entorno aislado; renombrar en Bitrix pendiente |
| 2 | Brochure PDF válido | **PARCIAL** | Validada mediante integración (16/16); falta fuente de PDF directo |
| 3 | Inicio de conversación | CORREGIDO | Probada en entorno aislado (modelo real) |
| 4 | Confirmar datos existentes | CORREGIDO | Probada en entorno aislado |
| 5 | Fee de titulación | CORREGIDO | Probada en entorno aislado (modelo real) |
| 6 | NOOCs fuera de la oferta | CORREGIDO | Probada en entorno aislado (modelo real) |
| 7 | Derivación al responsable vigente | CORREGIDO | Probada en entorno aislado |
| 8 | Secuencia de contacto | CORREGIDO | Probada en entorno aislado; aprobación de la secuencia pendiente |
| 9 | Ejecutivos ajenos a Carver | CORREGIDO | Probada en entorno aislado; departamentos validados en Bitrix |
| 10 | Estudiantes matriculados | CORREGIDO | Probada en entorno aislado; embudo y Advisors validados en Bitrix |
| 11 | Repeticiones y extensión | CORREGIDO | Probada en entorno aislado (modelo real) |

El paso a «Verificada en producción» depende del despliegue y de la observación posterior (§11).

## 8. Estado de los cuatro contenidos comerciales

Integración técnica: **Implementada y probada** (`consultar_informacion_institucional`, archivo
`data/carver/conocimiento-comercial.json`). Ningún contenido se inventó: no existen en el sitio oficial
(revisado) ni en el repositorio.

| Contenido | Aceptación técnica | Aceptación comercial | Qué falta |
|---|---|---|---|
| Calendario de ingresos por ciclo | Lista | **Pendiente** | Ciclos, inicio de clases, cierre de postulación, programas; fuente y responsable |
| Argumentos de venta | Lista | **Pendiente de validación formal** | Hoy hay 5 argumentos en uso (licencia CIE 12743, apostilla, modalidad, acompañamiento, beca), tomados de conversaciones de asesoras, no de un documento institucional |
| Enlace oficial de postulación del agente | Lista (por asesor) | **Pendiente** | Un enlace `https://` por usuario de Bitrix del asesor de ventas |
| Proceso de admisión y matrícula | Lista | **Pendiente** | Pasos en orden, con fuente |

Reglas de respuesta: lo que no está **validado, vigente, completo y sin contradicciones** se responde
como dato no disponible: el bot no lo inventa, ofrece que el asesor lo confirme y deja la consulta
registrada. Una fecha de inicio ya pasada no se ofrece como próximo ingreso. Dos fechas distintas para
el mismo ciclo y programa cuentan como contradicción. El enlace de postulación es solo el del asesor
del caso.

## 9. Riesgos residuales

- **Nombre visible del bot**: hasta ejecutar `imbot.update`, el chat sigue mostrando «Sofía · Carver».
- **Brochure como visor**: válido y verificado, pero alojado en el portal de la U. Autónoma. Si el
  visor cambia de formato, el bot deja de entregarlo (degradación segura) hasta que se ajuste.
- **Traspaso por sesión**: tras derivar, el bot calla durante toda la sesión de Open Lines. Si nadie
  la atiende, el cliente espera hasta que un asesor responda; la vigilancia de derivaciones avisa a las
  4 h al responsable y a las 24 h al supervisor (si está configurado).
- **Modelo no determinista**: el guardián cubre fee, enlaces, markdown, repetición y registros
  fallidos, pero no todo el contenido. La revisión diaria y la suite de regresión siguen siendo
  necesarias.
- **Vinculación equivocada de fichas** (números compartidos): el bot podría tratar a alguien como
  estudiante de otra persona. Mitigación: los datos personales se enmascaran y el único dato de un
  tercero que se entrega es el correo institucional de una Advisor.
- **Contradicción matrícula/inscripción** (N03) sin resolver en los datos.

## 10. Estado de Bitrix24 y de la integración

- Verificado en el portal real (solo lectura): embudos 73, 135 y 107 y sus etapas; departamentos
  193, 509 y 511; usuarios Advisor (activos, `@carver.university`); robot 45; formato de
  `entity_data_1`, que incluye el ID de sesión de Open Lines; los 16 visores de brochure.
- La API devolvió `OPERATION_TIME_LIMIT` al listar negociaciones con el webhook. No se reintentó en
  bucle, y la medición masiva de asignaciones se reemplazó por el análisis del código y del rastro del
  bot.
- Escrituras que hace el código nuevo en producción, siempre sobre la ficha de la conversación en
  curso: tarea al asesor o a la Advisor (una por caso y plazo), reasignación al punto de entrada solo
  si el responsable no es válido, con nota en la ficha y fila de auditoría. **No se tocó ningún
  registro histórico** ni se ejecutaron envíos masivos.
- Duplicados: tareas protegidas por candado por ficha y asesor; autoescalada una vez por conversación;
  recordatorios con tope diario.

## 11. Despliegue y verificación

**Controles críticos previos (todos aprobados el 2026-10-13):** tipos sin errores; 522/522 tests;
regresión de referencia 12/12; brochures 16/16; huella de Postgrados idéntica; arranque en frío con
`MARCA=carver` y `/health` OK; diff revisado (sin secretos y sin archivos ajenos: quedaron fuera
`data/carver/precios-*.json` y `prompt-sofia-*.txt`); rama sincronizada con `origin/main`; sin
migraciones; recuperación verificada (despliegues anteriores con `canRollback: true`); ninguna prueba
dejó operaciones reales pendientes.

**Despliegue:** commit `add3167` en `main` (rama `auditoria-carver-2026-10`, fusión fast-forward). Railway
desplegó los dos servicios:

| Servicio | Despliegue | Estado | `/health` | Arranque |
|---|---|---|---|---|
| `botcarver` (Carver) | `829430d7` | SUCCESS | `ok`, Redis persistente | Postgres conectado; seguimiento con `segundoHoras: 10`; recibe tráfico |
| `botbitrix24` (Postgrados) | `58f8aea9` | SUCCESS | `ok`, Redis persistente | Postgres conectado; seguimiento con `segundoHoras: 0` (su comportamiento real anterior) |

**Verificación posterior:** primeros eventos reales en Carver procesados sin errores (por ejemplo,
mensajes de un operador humano detectados y el bot en silencio). La verificación de los flujos
nuevos con conversaciones reales (guardián, brochure, estudiantes, traspaso por sesión) depende del
tráfico que llegue y debe seguirse en los próximos días con las nuevas filas de auditoría:
`guard_respuesta`, `brochure`, `bot_en_silencio`, `derivacion`, `seguimiento_omitido`,
`seguimiento_respondido` y `conocimiento`. Hasta entonces, el estado de esos flujos es **probado en
entorno aislado**, no **verificado en producción**.

## 12. Procedimiento de recuperación

1. **Railway (inmediato, sin código)**: proyecto `botbitrix24` → servicio `botcarver` (y
   `botbitrix24` si hiciera falta) → *Deployments* → despliegue anterior → *Rollback*. Despliegues
   previos verificados como recuperables: `5605aa10` en Carver (commit `f822e1e`).
2. **Git**: `git revert <commit-de-esta-auditoría>` y `git push origin main`. Railway vuelve a
   desplegar los dos servicios.
3. **Sin migraciones**: los cambios en Redis son claves nuevas (`traspaso:*`, `seguimiento:snapshot:*`,
   `seguimiento:enviados:*`, `seguimiento:ultimo:*`, `estudiante:*`, `autoescalado:*`). El código
   anterior las ignora. Postgres solo recibe nuevos valores de `type` en `audit_log` (columna de texto
   libre).
4. Ajustes sin redesplegar código (variables de Railway): `MAX_CARACTERES_RESPUESTA=0` (sin
   condensación), `SEGUIMIENTO_INSTANTANEA=false`, `SEGUIMIENTO_SEGUNDO_HORAS=0`,
   `SEGUIMIENTO_MAX_POR_DIA=0`, `DATOS_CONOCIDOS_DESDE_LEAD=false`, `BITRIX_EQUIPO_USUARIOS=<ids>`.

## 13. Pendientes y recomendaciones

1. **Identidad oficial** (negocio): confirmar «Carver University» como nombre visible, o el que
   corresponda, y aplicarlo con `GET /setup/update-bot` (requiere `ADMIN_TOKEN`).
2. **Brochure en PDF directo** (marketing/TI): publicar los PDF con una URL de descarga directa (por
   ejemplo en `carver.university`) o indicar la carpeta de Bitrix Disk donde están. El código ya acepta
   `brochurePdfUrl` por programa y lo prefiere al visor.
3. **Cargar y validar los cuatro contenidos** de `data/carver/conocimiento-comercial.json` con fuente,
   responsable y vigencia.
4. **Aclarar N03** (matrícula frente a inscripción) en la planilla comercial.
5. **Aprobar la secuencia de contacto** (3 h / tarea a 4 h / 10 h, máx. 2 por día) y considerar la zona
   horaria de cada país: la ventana actual es la de Chile.
6. **Confirmar N04**: el punto de entrada fuera del árbol de departamentos de Carver.
7. **Postgrados (N05)**: decidir si se activan ahí la instantánea del seguimiento y el traspaso por
   sesión. Hoy quedan apagados.
8. Repetir la suite de referencia antes de cada cambio de prompt:
   `MARCA=carver REGRESION_CONJUNTO=referencia npm run regresion`.
