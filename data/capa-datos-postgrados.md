# Capa de Datos — Agente Soporte Postgrados (Funnel 103)

**Fuente:** Planilla maestra de programas 2026 (Dirección de Postgrados, UA).  
**Fecha de corte:** 27-07-2026.  
**Uso:** tabla de consulta del agente para responder precios, descuentos, matrícula, condiciones de pago y derivaciones.

> **Convención de vigencia:** todo valor marcado `⬜ POR CONFIRMAR` NO debe ser entregado por el agente. Si el dato requerido está en ese estado, el agente responde con el guion de espera y deriva según la tabla de escalamiento (sección 4).

---

## 1. Reglas globales de precio y descuento

| Regla | Valor | Notas |
|---|---|---|
| Precio de lista | Campo `arancel_lista` de la tabla maestra | Precio publicado en web sin descuento |
| Descuento vigente | Campo `dto_%` de la tabla maestra | Es el **descuento institucional 2026 ya aprobado**, no negociable por el asesor |
| Arancel con descuento | `arancel_lista × (1 − dto)` | Valor que se comunica al postulante |
| Matrícula | Campo `matrícula` | **Se paga aparte del arancel.** No está incluida en el arancel con descuento |
| Costo total programa | `matrícula + arancel_con_dto` | Valor que debe comunicarse cuando preguntan "cuánto sale en total" |
| Descuentos acumulables | ⬜ POR CONFIRMAR | ¿El dto. institucional se acumula con convenio/ex-alumno? |
| Vigencia del descuento | ⬜ POR CONFIRMAR | ¿Fecha de término o es permanente 2026? |
| Programas con arancel liberado | Masivos con `dto = 100%` (ver sección 6) | Paga **solo matrícula** ($150.000). El arancel queda en $0 |

**Matrícula por tipo de programa (referencia rápida):**

| Tipo de programa | Matrícula estándar | Excepciones |
|---|---|---|
| Diplomado Online | $150.000 | — |
| Diplomado Presencial / Semipresencial | $250.000 | DI-REH-109 y DI-TRA-117: $200.000 |
| Magíster Online | $250.000 | MAG-TRA-186, MAG-DID-145, MAG-PAT-181, MAG-DEP-134: $200.000 |
| Máster | $250.000 | MAG-SEA-188 (Sexología): $350.000 |
| Especialidad Odontológica | $350.000 | — |

---

## 2. Condiciones de pago — Toku

| Parámetro | Valor | Estado |
|---|---|---|
| Requisito para pagar | **Tarjeta** (único medio habilitado) | Confirmado |
| Medios de pago habilitados | **Débito o crédito** | Confirmado |
| Cuotas — Diplomado (todas las modalidades) | **Hasta 5 cuotas** | Confirmado |
| Cuotas — Magíster | **Hasta 24 cuotas** | Confirmado |
| Cuotas — Máster | ⬜ POR CONFIRMAR (¿aplica regla de Magíster?) | Pendiente |
| Cuotas — Especialidad Odontológica | ⬜ POR CONFIRMAR | Pendiente |
| Forma de cálculo | El precio del programa se **divide en partes iguales** por el n.º de cuotas | Confirmado |
| ¿Las cuotas tienen interés? | ⬜ POR CONFIRMAR | Pendiente |
| Monto mínimo de cuota | ⬜ POR CONFIRMAR | Pendiente |
| ¿La matrícula entra en el plan de cuotas o se paga aparte? | ⬜ POR CONFIRMAR | Pendiente |
| Generación de link de pago | **Batch (script programado)**, no en línea | Confirmado |
| Consulta de estado de transacción en tiempo real | **NO disponible** — fuera de alcance Fase 1 | Confirmado |

**Base de cálculo usada en este documento:** la columna `Cuota máx.` de la sección 6 divide el **arancel con descuento** (sin matrícula) por el n.º máximo de cuotas del tipo de programa. Si se confirma que la matrícula entra en el plan, debe recalcularse sobre el total.

**Regla dura del agente (Fase 1):** el agente **nunca** afirma que un pago fue recibido, rechazado o está pendiente. Si el usuario consulta por el estado de un pago, se deriva (ver sección 4).

---

## 3. Links operativos

| Concepto | URL | Estado |
|---|---|---|
| **Formulario de soporte / contacto (Postmatrículas)** | `https://postgrados.uautonoma.cl/soporte/` | **Confirmado** |
| Ficha del programa (web pública) | `⬜ POR CONFIRMAR` — patrón de URL por programa | Pendiente |
| Formulario de postulación | `⬜ POR CONFIRMAR` | Pendiente |
| Link de pago de matrícula (Toku) | Se genera por batch; **no es una URL fija** | Confirmado |
| Portal del estudiante | `⬜ POR CONFIRMAR` | Pendiente |
| Solicitud de certificados | `⬜ POR CONFIRMAR` | Pendiente |
| Reglamento académico de postgrado | `⬜ POR CONFIRMAR` | Pendiente |
| Documentos requeridos para matrícula | `⬜ POR CONFIRMAR` | Pendiente |

---

## 4. Derivación y escalamiento

**Canal único de derivación:** formulario web de Postgrados → `https://postgrados.uautonoma.cl/soporte/`  
**Área responsable:** Postmatrículas.  
**SLA comprometido:** el usuario será contactado en un **plazo máximo de 2 días**.

| Tipo de caso | Sistema fuente | Acción del agente | Deriva a | SLA |
|---|---|---|---|---|
| **Deuda / estado de cuenta** | Banner (vía Ethos) | No consulta, no estima, no confirma montos | Postmatrículas → formulario web | 2 días |
| **Estado de matrícula del alumno** | Banner (vía Ethos) | No confirma si está matriculado | Postmatrículas → formulario web | 2 días |
| **Becas y beneficios institucionales** | Banner (vía Ethos) | No confirma asignación ni monto | Postmatrículas → formulario web | 2 días |
| **Estado de pago / transacción Toku** | Toku (sin API de consulta) | No confirma recepción de pago | Postmatrículas → formulario web | 2 días |
| **Reclamo formal** | — | No gestiona ni califica el reclamo | Postmatrículas → formulario web | 2 días |
| **Problema técnico de plataforma** | — | No diagnostica | Postmatrículas → formulario web | 2 días |
| **Consulta comercial de programa nuevo** | Bitrix24 | Responde con la tabla maestra | Asesor comercial del programa | — |
| **Precio / descuento / cuotas / total** | Esta capa de datos | Responde directamente | — | — |

> **Nota:** matrícula, deuda y beca viven en Banner vía Ethos y quedan **fuera de alcance de Fase 1**. La derivación es siempre a humano.

### 4.1 Guion base de derivación

> Para revisar tu caso necesito derivarte al área de Postmatrículas, que es quien tiene acceso a esa información. Te dejo el formulario de contacto: https://postgrados.uautonoma.cl/soporte/ — al completarlo serás contactado en un plazo máximo de 2 días hábiles.

**Restricciones del guion:**

- No prometer plazos menores a 2 días.
- No anticipar el resultado de la gestión (montos, aprobaciones, condonaciones).
- No ofrecer canales alternativos (correo directo, teléfono de asesor) salvo que se agreguen a esta capa.

---

## 5. Beneficios vigentes

| Beneficio | ¿Vigente? | % / Monto | Requisito de acreditación | Acumulable con dto. institucional |
|---|---|---|---|---|
| Descuento ex-alumno UA | ⬜ | ⬜ | ⬜ | ⬜ |
| Convenio institucional / empresa | ⬜ | ⬜ | ⬜ | ⬜ |
| Descuento por pago contado | ⬜ | ⬜ | ⬜ | ⬜ |
| Descuento grupal | ⬜ | ⬜ | ⬜ | ⬜ |
| Descuento funcionario UA | ⬜ | ⬜ | ⬜ | ⬜ |
| Campaña vigente (ej. Cyberday) | ⬜ | ⬜ | ⬜ | ⬜ |

**Regla:** mientras esta sección esté sin confirmar, el agente comunica **únicamente** el descuento institucional del campo `dto_%` y no menciona la existencia de otros beneficios.

---

## 6. Tabla maestra de programas (148 programas con arancel)

Columna `Cuota máx.` = arancel con descuento dividido por el n.º máximo de cuotas del tipo (Diplomado 5 / Magíster 24). No incluye matrícula.

| Código | Programa | Tipo | Área | Modalidad | Matrícula | Arancel lista | Dto. | Arancel c/dto | **Total** | Cuota máx. | Estado |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| `DI-DOC-037` | Docencia Universitaria en Ciencias de la Salud | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.290.000 | 40% | $774.000 | **$924.000** | $154.800 x5 | ACTIVO |
| `DI-SAL-115` | Salud Mental y Psiquiatría | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.390.000 | 40% | $834.000 | **$984.000** | $166.800 x5 | ACTIVO |
| `DI-DER-028` | Derecho de Familia, Infancia y Adolescencia | Diplomado | Derecho | Online | $150.000 | $1.290.000 | 40% | $774.000 | **$924.000** | $154.800 x5 | ACTIVO |
| `DI-GER-053` | Geriatría y Gerontología | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.390.000 | 40% | $834.000 | **$984.000** | $166.800 x5 | ACTIVO |
| `DI-GES-056` | Gestión de Instituciones de Organizaciones de Salud | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.290.000 | 40% | $774.000 | **$924.000** | $154.800 x5 | ACTIVO |
| `DI-NEU-089` | Neurociencia Clínica y Neurorrehabilitación | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-PSI-107` | Psicoterapia Infanto Juvenil | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.290.000 | 40% | $774.000 | **$924.000** | $154.800 x5 | ACTIVO |
| `DI-DOC-036` | Docencia e Innovación de la Educación Superior | Diplomado | Educación | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-SAL-113` | Salud Familiar y Comunitaria | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.290.000 | 40% | $774.000 | **$924.000** | $154.800 x5 | ACTIVO |
| `DI-INT-077` | Intervención en Trastorno del Espectro Autista | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.390.000 | 40% | $834.000 | **$984.000** | $166.800 x5 | ACTIVO |
| `DI-PAC-099` | Paciente Crítico Adulto | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.290.000 | 40% | $774.000 | **$924.000** | $154.800 x5 | ACTIVO |
| `DI-GES-057` | Gestión de la Calidad y Acreditación en Salud | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.390.000 | 40% | $834.000 | **$984.000** | $166.800 x5 | ACTIVO |
| `DI-GER-052` | Gerencia de Proyectos, Enfoque PMP® | Diplomado | Administración y Negocios | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-PSI-105` | Psicología Forense y Evaluación Pericial | Diplomado | Cs. Sociales y Humanidades | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-CON-018` | Consejería en Lactancia Materna | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-MET-084` | Métodos de Investigación y Publicaciones Académicas | Diplomado | Educación | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-BUS-011` | Business Analytics and Data Science | Diplomado | Administración y Negocios | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-PTH-108` | Python y Data Science | Diplomado | Ingeniería | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-MOT-086` | Motricidad Orofacial | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.390.000 | 40% | $834.000 | **$984.000** | $166.800 x5 | ACTIVO |
| `DI-PIS-100` | Piso Pélvico para Profesionales de la Salud | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.290.000 | 40% | $774.000 | **$924.000** | $154.800 x5 | ACTIVO |
| `DI-NEU-092` | Neurorrehabilitación Infantil e Integración Sensorial | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.390.000 | 40% | $834.000 | **$984.000** | $166.800 x5 | ACTIVO |
| `DI-NEU-091` | Neurorrehabilitación del Adulto | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-COM-017` | Comunicación Estratégica | Diplomado | Cs. Sociales y Humanidades | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-PSI-106` | Psicoterapia Cognitiva Constructiva y Terapias Contextuales | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-ARQ-005` | Arquitectura de Software | Diplomado | Ingeniería | Online | $150.000 | $1.190.000 | 40% | $714.000 | **$864.000** | $142.800 x5 | ACTIVO |
| `DI-DIS-033` | Diseño, Gestión e Innovación Curricular | Diplomado | Educación | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-INT-073` | Inteligencia Artificial | Diplomado | Ingeniería | Online | $150.000 | $1.190.000 | 40% | $714.000 | **$864.000** | $142.800 x5 | ACTIVO |
| `DI-GES-059` | Gestión de Riesgos y Auditoría Clínica para Instituciones de Salud | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-CUI-022` | Cuidados Paliativos y Manejo del Dolor | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-PSI-103` | Psicología Clínica: Diagnóstico y Psicoterapia | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.390.000 | 40% | $834.000 | **$984.000** | $166.800 x5 | ACTIVO |
| `DI-DER-029` | Derecho del Trabajo y Proceso Laboral | Diplomado | Derecho | Online | $150.000 | $1.290.000 | 40% | $774.000 | **$924.000** | $154.800 x5 | ACTIVO |
| `DI-NOR-093` | Normas Internacionales de Información Financiera | Diplomado | Administración y Negocios | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-MAR-083` | Marketing y Comunicación Digital | Diplomado | Administración y Negocios | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-EOM-038` | Economía Financiera y Gestión Empresarial | Diplomado | Administración y Negocios | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-PSI-104` | Psicología del Deporte | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-MIN-085` | Mindfulness | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-ENF-043` | Enfermería en Cuidados de la Persona en Hemodiálisis | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-REH-111` | Rehabilitación y Habilidades Deportivas Post Lesiones | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-GES-058` | Gestión de Personas | Diplomado | Administración y Negocios | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-LIR-081` | Liderazgo para el Sector Público | Diplomado | Cs. Sociales y Humanidades | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-ENE-042` | Energías Renovables (EERR) | Diplomado | Arq., Construcción y M. Ambiente | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-GES-060` | Gestión del Riesgo de Desastres | Diplomado | Arq., Construcción y M. Ambiente | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-CUI-023` | Cuidados Respiratorios para Kinesiólogos | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-CUI-020` | Cuidados de Enfermería en Paciente Oncológico | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-ADM-001` | Administración de Obras | Diplomado | Arq., Construcción y M. Ambiente | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-INC-068` | Inclusión Educativa de Personas en Condición del Espectro Autista | Diplomado | Educación | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-AST-007` | Astronomía General | Diplomado | Cs. Sociales y Humanidades | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-HEM-065` | Hemato-Oncología Traslacional | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.290.000 | 40% | $774.000 | **$924.000** | $154.800 x5 | ACTIVO |
| `DI-DER-026` | Derecho Ambiental y Gestión Sostenible | Diplomado | Derecho | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-AUT-008` | Autoridad Sanitaria Nacional | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-CUI-019` | Cuidado Quirúrgico Gineco Obstétrico | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-ASI-006` | Asistencia del Recién Nacido de Alto Riesgo | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-AMO-002` | Amor, Sexualidad y Apego | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-LIT-082` | Litigación Oral | Diplomado | Derecho | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-EVA-049` | Evaluación Neuropsicológica | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-DIS-034` | Disfunción Sexual Femenina | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-PRU-102` | Pruebas en el Proceso Penal Acusatorio y Litigación Estratégica | Diplomado | Derecho | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-ANT-004` | Antibióticos y Terapia Antimicrobiana | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-BIE-009` | Bienestar Laboral y Riesgos Psicosociales | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-INS-072` | Inspección Técnica de Obras | Diplomado | Arq., Construcción y M. Ambiente | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-CLI-014` | Clínica Psicoanalítica | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-EOM-039` | Economía y Políticas Públicas | Diplomado | Cs. Sociales y Humanidades | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-HAB-064` | Habilidades Directivas | Diplomado | Administración y Negocios | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-ENF-046` | Enfermería Pediátrica | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-INT-079` | Intervención Terapéutica Familiar | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-DER-031` | Derecho Penal Económico y de las Empresas | Diplomado | Derecho | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-ANA-003` | Analgesia y Sedación Odontológica | Diplomado | Odontología | Online | $150.000 | $1.290.000 | 40% | $774.000 | **$924.000** | $154.800 x5 | ACTIVO |
| `DI-VEJ-120` | Vejez, Envejecimiento y Salud Mental | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-DER-025` | Derecho Aduanero | Diplomado | Derecho | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-FIS-050` | Fisiología Clínica del Ejercicio | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-GES-062` | Gestión Estratégica de Evaluación y Selección de Personas | Diplomado | Administración y Negocios | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-COM-016` | Compliance e Integridad Corporativa | Diplomado | Derecho | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-BIO-010` | Bioestadísticas Aplicadas al Área de la Salud | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-NEU-090` | Neurociencia Humana y Neuropsicología | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-URG-119` | Urgencias Hospitalarias | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.290.000 | 40% | $774.000 | **$924.000** | $154.800 x5 | ACTIVO |
| `DI-TRA-116` | Trading e Inversiones | Diplomado | Administración y Negocios | Online | $150.000 | $1.190.000 | 40% | $714.000 | **$864.000** | $142.800 x5 | ACTIVO |
| `DI-NEU-088` | Neuroarquitectura de Interiores | Diplomado | Arq., Construcción y M. Ambiente | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-VIO-121` | Violencia Sexual y Maltrato Infanto Juvenil | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.290.000 | 40% | $774.000 | **$924.000** | $154.800 x5 | ACTIVO |
| `DI-CIB-013` | Ciberseguridad y Ciberdefensa | Diplomado | Ingeniería | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-DOC-035` | Docencia Basada en Simulación Clínica | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.290.000 | 40% | $774.000 | **$924.000** | $154.800 x5 | ACTIVO |
| `DI-NUT-094` | Nutrición y Alimentación para Rendimiento Deportivo y Salud | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-GES-055` | Gestión de Farmacia Asistencial | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.290.000 | 40% | $774.000 | **$924.000** | $154.800 x5 | ACTIVO |
| `DI-CAR-012` | Cariología Clínica | Diplomado | Odontología | Online | $150.000 | $1.290.000 | 40% | $774.000 | **$924.000** | $154.800 x5 | ACTIVO |
| `DI-GES-061` | Gestión en Seguridad y Salud Ocupacional ISO 45.001 | Diplomado | Ciencias de la Salud | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | ACTIVO |
| `DI-LE-080` | Ley Karin y Acoso Laboral | Diplomado | Derecho | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | PAUSA |
| `DI-IGU-066` | Igualdad y Género en el Ámbito Público y Privado | Diplomado | Cs. Sociales y Humanidades | Online | $150.000 | $1.090.000 | 40% | $654.000 | **$804.000** | $130.800 x5 | PAUSA |
| `DI-REH-109` | Rehabilitación Oral Integral y Estética Adhesiva | Diplomado Presencial | Odontología | Presencial Santiago | $200.000 | $3.490.000 | 20% | $2.792.000 | **$2.992.000** | $558.400 x5 | ACTIVO |
| `DI-END-040` | Endodoncia Clínica Mecanizada y Cirugía Apical | Diplomado Presencial | Odontología | Presencial Santiago | $250.000 | $3.490.000 | 10% | $3.141.000 | **$3.391.000** | $628.200 x5 | ACTIVO |
| `DI-ODO-096` | Odontopediatría Clínica | Diplomado Presencial | Odontología | Presencial Temuco | $250.000 | $3.290.000 | 10% | $2.961.000 | **$3.211.000** | $592.200 x5 | ACTIVO |
| `DI-ODO-095` | Odontopediatría Clínica | Diplomado Presencial | Odontología | Presencial Santiago | $250.000 | $3.290.000 | 10% | $2.961.000 | **$3.211.000** | $592.200 x5 | ACTIVO |
| `DI-IMP-067` | Implantología Oral Enfoque Quirúrgico Protésico | Diplomado Presencial | Odontología | Presencial Santiago | $250.000 | $4.590.000 | 10% | $4.131.000 | **$4.381.000** | $826.200 x5 | ACTIVO |
| `DI-END-041` | Endodoncia Clínica Mecanizada y Cirugía Apical | Diplomado Presencial | Odontología | Presencial Temuco | $250.000 | $3.490.000 | 10% | $3.141.000 | **$3.391.000** | $628.200 x5 | PAUSA |
| `DI-TRA-117` | Trastornos Temporomandibulares y Dolor Orofacial | Diplomado Presencial | Odontología | Presencial Santiago | $200.000 | $2.790.000 | 10% | $2.511.000 | **$2.711.000** | $502.200 x5 | SUSPENDIDO |
| `DI-ORT-098` | Ortodoncia Preventiva e Interceptiva y Ortopedia DMF | Diplomado Semipresencial | Odontología | Semipresencial Santiago | $250.000 | $3.990.000 | 10% | $3.591.000 | **$3.841.000** | $718.200 x5 | PAUSA |
| `DI-TRA-118` | Trastornos Temporomandibulares y Dolor Orofacial | Diplomado Semipresencial | Odontología | Semipresencial Temuco | $250.000 | $2.750.000 | 10% | $2.475.000 | **$2.725.000** | $495.000 x5 | PAUSA |
| `MAG-GOB-167` | Gobierno y Dirección Pública | Magíster | Cs. Sociales y Humanidades | Online | $250.000 | $5.990.000 | 30% | $4.193.000 | **$4.443.000** | $174.708 x24 | ACTIVO |
| `MAG-EDU-154` | Educación en Ciencias de la Salud y Simulación Clínica | Magíster | Ciencias de la Salud | Online | $250.000 | $5.990.000 | 30% | $4.193.000 | **$4.443.000** | $174.708 x24 | ACTIVO |
| `MAG-DER-141` | Derecho Público: Transparencia, Regulaciones y Control | Magíster | Derecho | Online | $250.000 | $5.490.000 | 30% | $3.843.000 | **$4.093.000** | $160.125 x24 | ACTIVO |
| `MAG-DER-140` | Derecho Penal y Procesal Penal | Magíster | Derecho | Online | $250.000 | $5.490.000 | 30% | $3.843.000 | **$4.093.000** | $160.125 x24 | ACTIVO |
| `MAG-DES-143` | Desarrollo Organizacional, Innovación y Bienestar Laboral | Magíster | Cs. Sociales y Humanidades | Online | $250.000 | $5.490.000 | 30% | $3.843.000 | **$4.093.000** | $160.125 x24 | ACTIVO |
| `MAG-GES-164` | Gestión Estratégica de Organizaciones de Salud | Magíster | Ciencias de la Salud | Online | $250.000 | $5.990.000 | 30% | $4.193.000 | **$4.443.000** | $174.708 x24 | ACTIVO |
| `MAG-PSI-182` | Psicología Clínica | Magíster | Ciencias de la Salud | Online | $250.000 | $6.490.000 | 30% | $4.543.000 | **$4.793.000** | $189.292 x24 | ACTIVO |
| `MAG-DER-138` | Derecho del Trabajo, Procedimientos y Litigación Laboral | Magíster | Derecho | Online | $250.000 | $5.490.000 | 30% | $3.843.000 | **$4.093.000** | $160.125 x24 | ACTIVO |
| `MAG-DIR-151` | Dirección y Gestión Escolar de la Calidad | Magíster | Educación | Online | $250.000 | $4.490.000 | 30% | $3.143.000 | **$3.393.000** | $130.958 x24 | ACTIVO |
| `MAG-INT-171` | Inteligencia Artificial | Magíster | Ingeniería | Online | $250.000 | $6.990.000 | 30% | $4.893.000 | **$5.143.000** | $203.875 x24 | ACTIVO |
| `MAG-GOB-166` | Gobierno Corporativo y Compliance | Magíster | Derecho | Online | $250.000 | $5.490.000 | 40% | $3.294.000 | **$3.544.000** | $137.250 x24 | ACTIVO |
| `MAG-DES-142` | Desarrollo Económico, Social y Políticas Públicas | Magíster | Administración y Negocios | Online | $250.000 | $5.490.000 | 50% | $2.745.000 | **$2.995.000** | $114.375 x24 | ACTIVO |
| `MAG-FIN-160` | Finanzas y Gestión Financiera | Magíster | Administración y Negocios | Online | $250.000 | $5.490.000 | 30% | $3.843.000 | **$4.093.000** | $160.125 x24 | ACTIVO |
| `MAG-CRE-133` | Creatividad Estratégica para la Comunicación e IA Generativa | Magíster | Cs. Sociales y Humanidades | Online | $250.000 | $4.990.000 | 30% | $3.493.000 | **$3.743.000** | $145.542 x24 | ACTIVO |
| `MAG-TRA-186` | Trabajo Social | Magíster | Cs. Sociales y Humanidades | Online | $200.000 | $4.490.000 | 40% | $2.694.000 | **$2.894.000** | $112.250 x24 | ACTIVO |
| `MAG-DID-145` | Didáctica de la Lengua y la Literatura | Magíster | Educación | Online | $200.000 | $4.490.000 | 30% | $3.143.000 | **$3.343.000** | $130.958 x24 | ACTIVO |
| `MAG-INV-173` | Investigación en Diversidad e Inclusión | Magíster | Cs. Sociales y Humanidades | Online | $250.000 | $4.490.000 | 30% | $3.143.000 | **$3.393.000** | $130.958 x24 | ACTIVO |
| `MAG-PAT-181` | Patrimonio y Turismo | Magíster | Cs. Sociales y Humanidades | Online | $200.000 | $4.990.000 | 30% | $3.493.000 | **$3.693.000** | $145.542 x24 | ACTIVO |
| `MAG-INT-172` | Intervención con Familias e Infancia | Magíster | Cs. Sociales y Humanidades | Online | $250.000 | $5.490.000 | 30% | $3.843.000 | **$4.093.000** | $160.125 x24 | ACTIVO |
| `MAG-EDU-156` | Educación Mención Diseño e Innovación Curricular | Magíster | Educación | Online | $250.000 | $4.490.000 | 40% | $2.694.000 | **$2.944.000** | $112.250 x24 | ACTIVO |
| `MAG-DEP-134` | Deportes y Actividad Física | Magíster | Ciencias de la Salud | Online | $200.000 | $4.490.000 | 30% | $3.143.000 | **$3.343.000** | $130.958 x24 | ACTIVO |
| `MAG-DOC-152` | Docencia en Educación Superior | Magíster | Educación | Online | $250.000 | $4.490.000 | 40% | $2.694.000 | **$2.944.000** | $112.250 x24 | ACTIVO |
| `MAG-GER-162` | Gerontología para el Envejecimiento Activo | Magíster | Ciencias de la Salud | Online | $250.000 | $5.490.000 | 30% | $3.843.000 | **$4.093.000** | $160.125 x24 | ACTIVO |
| `MAG-DIR-147` | Dirección de Empresas MBA - Online | Magíster | Administración y Negocios | Online | $250.000 | $9.990.000 | 50% | $4.995.000 | **$5.245.000** | $208.125 x24 | ACTIVO |
| `MAG-ANA-131` | Analítica para los Negocios | Magíster | Administración y Negocios | Online | $250.000 | $5.490.000 | 40% | $3.294.000 | **$3.544.000** | $137.250 x24 | ACTIVO |
| `MAG-ADM-130` | Administración de la Construcción | Magíster | Arq., Construcción y M. Ambiente | Online | $250.000 | $4.990.000 | 40% | $2.994.000 | **$3.244.000** | $124.750 x24 | ACTIVO |
| `MAG-ING-168` | Ingeniería Industrial | Magíster | Ingeniería | Online | $250.000 | $5.990.000 | 40% | $3.594.000 | **$3.844.000** | $149.750 x24 | ACTIVO |
| `MAG-DER-136` | Derecho de Familia e Infancia | Magíster | Derecho | Online | $250.000 | $5.490.000 | 40% | $3.294.000 | **$3.544.000** | $137.250 x24 | ACTIVO |
| `MAG-CIC-132` | Ciencias Farmacéuticas | Magíster | Ciencias de la Salud | Online | $250.000 | $4.990.000 | 30% | $3.493.000 | **$3.743.000** | $145.542 x24 | ACTIVO |
| `MAG-DIR-148` | Dirección de Operaciones, Logística y Cadena de Suministro | Magíster | Administración y Negocios | Online | $250.000 | $7.990.000 | 50% | $3.995.000 | **$4.245.000** | $166.458 x24 | ACTIVO |
| `MAG-FOR-161` | Formulación y Evaluación de Proyectos | Magíster | Administración y Negocios | Online | $250.000 | $7.990.000 | 50% | $3.995.000 | **$4.245.000** | $166.458 x24 | ACTIVO |
| `MAG-DIR-149` | Dirección de Personas y Gestión del Talento | Magíster | Administración y Negocios | Online | $250.000 | $7.990.000 | 50% | $3.995.000 | **$4.245.000** | $166.458 x24 | ACTIVO |
| `MAG-DIR-146` | Dirección de Empresas MBA | Magíster | Administración y Negocios | Presencial Santiago | $250.000 | $8.990.000 | 50% | $4.495.000 | **$4.745.000** | $187.292 x24 | ACTIVO |
| `MAG-NEU-176` | Neurociencias | Magíster | Ciencias de la Salud | Presencial Santiago | $250.000 | $6.490.000 | 30% | $4.543.000 | **$4.793.000** | $189.292 x24 | ACTIVO |
| `MAG-NEU-177` | Neurociencias | Magíster | Ciencias de la Salud | Presencial Temuco | $250.000 | $6.490.000 | 30% | $4.543.000 | **$4.793.000** | $189.292 x24 | ACTIVO |
| `MAG-NEU-180` | Neurodivergencia | Magíster | Ciencias de la Salud | Online | $250.000 | $6.990.000 | 30% | $4.893.000 | **$5.143.000** | $203.875 x24 | MATRÍCULA CERRADA |
| `MAG-TEC-185` | Tecnologías Aplicadas a la Construcción | Magíster | Arq., Construcción y M. Ambiente | Online | $250.000 | $4.990.000 | 50% | $2.495.000 | **$2.745.000** | $103.958 x24 | MATRÍCULA CERRADA |
| `MAG-JUS-174` | Justicia Constitucional y Derechos Humanos | Magíster | Derecho | Online | $250.000 | $4.990.000 | 30% | $3.493.000 | **$3.743.000** | $145.542 x24 | SUSPENDIDO |
| `MAG-DER-135` | Derecho de Consumo y Comercio Electrónico | Magíster | Derecho | Online | $250.000 | $3.990.000 | 30% | $2.793.000 | **$3.043.000** | $116.375 x24 | SUSPENDIDO |
| `MAG-EOM-153` | Economía Circular Industrial | Magíster | Ingeniería | Online | $250.000 | $4.990.000 | 30% | $3.493.000 | **$3.743.000** | $145.542 x24 | SUSPENDIDO |
| `MAG-GES-165` | Gestión y Desarrollo Municipal | Magíster Nuevo 2026 | Cs. Sociales y Humanidades | Online | $250.000 | $4.990.000 | 30% | $3.493.000 | **$3.743.000** | $145.542 x24 | ACTIVO |
| `MAG-MAR-175` | Marketing Digital | Magíster Nuevo 2026 | Administración y Negocios | Online | $250.000 | $4.990.000 | 30% | $3.493.000 | **$3.743.000** | $145.542 x24 | ACTIVO |
| `MAG-NEU-178` | Neurorrehabilitación | Magíster Nuevo 2026 | Cs. Sociales y Humanidades | Online | $250.000 | $5.990.000 | 30% | $4.193.000 | **$4.443.000** | $174.708 x24 | ACTIVO |
| `MAG-INN-169` | Innovación | Magíster Nuevo 2026 | Administración y Negocios | Online | $250.000 | $4.990.000 | 30% | $3.493.000 | **$3.743.000** | $145.542 x24 | SUSPENDIDO |
| `MAG-INV-187` | Investigación y Gestión de Emergencia y Desastre | Máster | Arq., Construcción y M. Ambiente | Presencial Santiago | $250.000 | $5.490.000 | 30% | $3.843.000 | **$4.093.000** | ⬜ | ACTIVO |
| `MAG-SEA-188` | Sexología | Máster | Ciencias de la Salud | Presencial Santiago | $350.000 | $8.990.000 | 30% | $6.293.000 | **$6.643.000** | ⬜ | ACTIVO |
| `ESP-BMF-126` | Implantología Bucomaxilofacial | Especialidad | Odontología | Presencial Santiago | $350.000 | $10.490.000 | 10% | $9.441.000 | **$9.791.000** | ⬜ | ACTIVO |
| `ESP-BMF-127` | Implantología Bucomaxilofacial | Especialidad | Odontología | Presencial Temuco | $350.000 | $10.490.000 | 10% | $9.441.000 | **$9.791.000** | ⬜ | ACTIVO |
| `ESP-ROI-128` | Rehabilitación Oral | Especialidad | Odontología | Presencial Santiago | $350.000 | $10.490.000 | 10% | $9.441.000 | **$9.791.000** | ⬜ | ACTIVO |
| `ESP-ROI-129` | Rehabilitación Oral | Especialidad | Odontología | Presencial Temuco | $350.000 | $10.490.000 | 10% | $9.441.000 | **$9.791.000** | ⬜ | ACTIVO |
| `ESP-END-123` | Endodoncia | Especialidad | Odontología | Presencial Santiago | $350.000 | $8.990.000 | 10% | $8.091.000 | **$8.441.000** | ⬜ | ACTIVO |
| `ESP-END-124` | Endodoncia | Especialidad | Odontología | Presencial Temuco | $350.000 | $8.990.000 | 10% | $8.091.000 | **$8.441.000** | ⬜ | ACTIVO |
| `ESP-IOM-125` | Imagenología Oral y Maxilofacial | Especialidad | Odontología | Presencial Santiago | $350.000 | $7.990.000 | 10% | $7.191.000 | **$7.541.000** | ⬜ | PAUSA |

---

## 7. Programas masivos (21)

Programas con **arancel liberado al 100%**: el postulante paga **solo la matrícula de $150.000**. Excepción: `DI-DAT-024` mantiene 30% de descuento sobre arancel.

| Código | Programa | Área | Matrícula | Arancel lista | Dto. | Arancel c/dto | **Total a pagar** | Cuota máx. |
|---|---|---|---:|---:|---:|---:|---:|---:|
| `DI-DAT-024` | Data Science para Organizaciones de Salud | Ciencias de la Salud | $150.000 | $1.290.000 | 30% | $903.000 | **$1.053.000** | $180.600 x5 |
| `DI-PRO-101` | Procesos de Formulación y Planificación Estratégica | Administración y Negocios | $150.000 | $1.090.000 | 100% | $0 | **$150.000** | — (solo matrícula) |
| `DI-NEO-087` | Neonatología y Pediatría Interprofesional desde la Atención Temprana | Ciencias de la Salud | $150.000 | $790.000 | 100% | $0 | **$150.000** | — (solo matrícula) |
| `DI-INF-069` | Infecciones Asociadas a Atención en Salud | Ciencias de la Salud | $150.000 | $790.000 | 100% | $0 | **$150.000** | — (solo matrícula) |
| `DI-INT-078` | Intervención Social, Estrategias de Inclusión y Gestión de la Diversidad | Cs. Sociales y Humanidades | $150.000 | $1.090.000 | 100% | $0 | **$150.000** | — (solo matrícula) |
| `DI-GES-054` | Gestión de Cuidados y Prácticas Enfermeras Avanzadas | Ciencias de la Salud | $150.000 | $990.000 | 100% | $0 | **$150.000** | — (solo matrícula) |
| `DI-GES-063` | Gestión y Liderazgo para Centros Educativos de la Primera Infancia | Educación | $150.000 | $790.000 | 100% | $0 | **$150.000** | — (solo matrícula) |
| `DI-DES-032` | Desarrollo de Habilidades Cognitivas desde un Enfoque Inclusivo | Cs. Sociales y Humanidades | $150.000 | $1.090.000 | 100% | $0 | **$150.000** | — (solo matrícula) |
| `DI-INT-076` | Intervención en Problemas de Pareja | Cs. Sociales y Humanidades | $150.000 | $790.000 | 100% | $0 | **$150.000** | — (solo matrícula) |
| `DI-CUI-021` | Cuidados Neonatales para Matronas | Ciencias de la Salud | $150.000 | $990.000 | 100% | $0 | **$150.000** | — (solo matrícula) |
| `DI-ENF-044` | Enfermería Hospitalaria en Atención Domiciliaria | Ciencias de la Salud | $150.000 | $990.000 | 100% | $0 | **$150.000** | — (solo matrícula) |
| `DI-EPI-047` | Epidemiología Clínica y Salud Pública | Ciencias de la Salud | $150.000 | $900.000 | 100% | $0 | **$150.000** | — (solo matrícula) |
| `DI-INT-074` | Intervención Clínica a lo Largo del Ciclo Vital | Ciencias de la Salud | $150.000 | $1.090.000 | 100% | $0 | **$150.000** | — (solo matrícula) |
| `DI-ONC-097` | Oncología: Prevención y Detección Precoz del Cáncer | Ciencias de la Salud | $150.000 | $790.000 | 100% | $0 | **$150.000** | — (solo matrícula) |
| `DI-REH-191` | Rehabilitación Transdisciplinaria Enfermedades Respiratorias | Ciencias de la Salud | $150.000 | $790.000 | 100% | $0 | **$150.000** | — (solo matrícula) |
| `DI-COM-015` | Competencias Digitales para la Docencia | Educación | $150.000 | $790.000 | 100% | $0 | **$150.000** | — (solo matrícula) |
| `DI-EVA-048` | Evaluación Auténtica y Retroalimentación Efectiva | Educación | $150.000 | $790.000 | 100% | $0 | **$150.000** | — (solo matrícula) |
| `DI-FOM-051` | Fomento y Mediación Lectora para la Primera Infancia | Educación | $150.000 | $900.000 | 100% | $0 | **$150.000** | — (solo matrícula) |
| `DI-GES-190` | Gestión de Convivencia Escolar | Educación | $150.000 | $900.000 | 100% | $0 | **$150.000** | — (solo matrícula) |
| `DI-INN-071` | Innovación en la Intervención Social y Educativa | Educación | $150.000 | $790.000 | 100% | $0 | **$150.000** | — (solo matrícula) |
| `DI-BIG-192` | Big Data and Machine Learning | Ingeniería | $150.000 | $990.000 | 100% | $0 | **$150.000** | — (solo matrícula) |

---

## 8. Programas nuevos — precio no confirmado en web (12)

> El agente **no debe cotizar** estos programas. Responde que la información estará disponible próximamente y deriva al asesor comercial.

| Código | Programa | Tipo | Matrícula ref. | Arancel ref. | Dto. ref. | Estado web |
|---|---|---|---:|---:|---:|---|
| `DI-CUI-193` | Cuidados Oncológicos del Niño, Niña y Adolescente | Diplomado Nuevo | $150.000 | $990.000 | 30% | Por actualizar |
| `DI-DEG-194` | Delegado de Protección de Datos | Diplomado Nuevo | $150.000 | $990.000 | 30% | Por actualizar |
| `DI-GES-195` | Gestión de Recursos Públicos | Diplomado Nuevo | $150.000 | $990.000 | 30% | Por actualizar |
| `DI-HUM-196` | Humanización del Cuidado en Salud | Diplomado Nuevo | $150.000 | $990.000 | 30% | Por actualizar |
| `DI-MET-197` | Metodologías Activas y Gamificación para la Enseñanza | Diplomado Nuevo | $150.000 | $990.000 | 30% | Por actualizar |
| `DI-PSI-198` | Psicomotricidad y Necesidades Educativas Especiales | Diplomado Nuevo | $150.000 | $990.000 | 30% | Por actualizar |
| `DI-RED-199` | Redacción de Contratos y Derecho Registral | Diplomado Nuevo | $150.000 | $990.000 | 30% | Por actualizar |
| `DI-CON-200` | Control de Gestión | Diplomado Nuevo | $150.000 | $990.000 | ⬜ | Por actualizar |
| `MAG-PSI-183` | Psicología Educacional y Gestión de la Inclusión Escolar | Magíster Nuevo 2026 | $250.000 | $4.990.000 | 30% | Por actualizar |
| `MAG-EPI-158` | Epidemiología | Magíster Nuevo 2026 | $250.000 | $4.990.000 | 30% | Por actualizar |
| `MAG-DAT-203` | Data Science | Magíster Nuevo 2026 | $250.000 | $4.990.000 | 30% | Por actualizar |
| `MAG-MAGI-207` | Gestión de la Inclusión y Convivencia Educativa | Magíster Nuevo 2026 | $250.000 | $5.490.000 | 30% | Por actualizar |

---

## 9. Programas sin datos comerciales — bloqueados para el agente

| Código | Programa | Estado |
|---|---|---|
| `MAG-CIC-201` | Ciencias para la Salud | SUSPENDIDO |
| `MAG-CIC-202` | Ciencias Políticas | SUSPENDIDO |
| `MAG-DIR-204` | Dirección y Administración (MBA) Salud | SUSPENDIDO |
| `MAG-INF-205` | Informática y Economía de la Salud | SUSPENDIDO |
| `MAG-SAL-206` | Salud Sexual, Reproductiva y Derechos Humanos | SUSPENDIDO |
| — | Diplomado en Intervención en Adicciones | Sin código / sin asignación |
| — | Diplomado en Derecho Administrativo | Sin datos |
| — | Magíster en Intervención Musculoesquelética | Sin datos |

---

## 11. Captura conversacional de postulación (reemplazo del formulario web)

Objetivo: que el agente levante los datos por chat y escriba directamente en Bitrix24, sin enviar al usuario a un formulario.

### 11.1 Mapa de campos → Bitrix24

| # | Campo | Entidad Bitrix24 | Tipo | Etapa | Oblig. | Validación |
|---|---|---|---|---|---|---|
| 1 | Área de interés | Negociación | Lista (10) | 1 | Sí | Debe existir en el catálogo 11.2 |
| 2 | Programa de interés | Negociación | Lista dependiente | 1 | Sí | Código válido y estado ACTIVO |
| 3 | Nombre | Contacto | Texto | 1 | Sí | Mín. 2 caracteres, sin dígitos |
| 4 | Primer Apellido | Contacto | Texto | 1 | Sí | Mín. 2 caracteres, sin dígitos |
| 5 | Segundo Apellido | Contacto | Texto | 2 | No | — |
| 6 | E-mail | Contacto | Email | 1 | Sí | Formato RFC + dominio con MX |
| 7 | Teléfono | Contacto | Teléfono | 1 | Sí | E.164. Prellenar con el número de WhatsApp origen |
| 8 | RUT / DNI | Negociación | Texto | 2 | Sí | RUT chileno: módulo 11. Extranjero: pasaporte/DNI libre |
| 9 | Nacionalidad | Negociación | Lista | 2 | Sí | ISO 3166, default Chile |
| 10 | Fecha de nacimiento | Contacto | Fecha | 2 | Sí | DD-MM-AAAA, edad ≥ 17 y ≤ 90 |
| 11 | Domicilio Particular | Contacto | Texto | 2 | Sí | Mín. 8 caracteres |
| 12 | Título y Grado Académico | Negociación | Texto | 3 | Sí | Texto libre |
| 13 | Institución de Obtención | Negociación | Texto | 3 | Sí | Texto libre |
| 14 | Año de Egreso | Negociación | Número | 3 | Sí | 1950 ≤ año ≤ año actual |
| 15 | Cédula de identidad (archivo) | Negociación | Adjunto | 3 | Sí | Ver 11.4 |

### 11.2 Selección de programa en dos pasos

El formulario web usa 10 buckets que **no coinciden** con la taxonomía de área de la tabla maestra. Regla de mapeo:

- `tipo = Especialidad` → **Especialidades**
- `tipo = Magíster` o `Magíster Nuevo 2026` → **Magísteres**
- `tipo = Diplomado` (incluye Presencial, Semipresencial y Masivo) → **Diplomado + área**

| Bucket del formulario | Programas ACTIVOS | Total en catálogo |
|---|---:|---:|
| Especialidades | 6 | 7 |
| Magísteres | 38 | 44 |
| Diplomado Administración y negocios | 10 | 10 |
| Diplomado Arquitectura, Construcción y Medio Ambiente | 5 | 5 |
| Diplomado Ciencias de la salud | 57 | 57 |
| Diplomado Ciencias sociales y Humanidades | 8 | 9 |
| Diplomado Derecho | 8 | 9 |
| Diplomado Educación | 10 | 10 |
| Diplomado Ingeniería | 5 | 5 |
| Diplomado Odontología | 7 | 11 |

**Regla:** la lista ofrecida se construye filtrando la sección 6 por bucket y `estado = ACTIVO`. No se enumeran programas en PAUSA, SUSPENDIDO ni MATRÍCULA CERRADA. La sección 6 es la única fuente de verdad; esta sección no duplica el catálogo.

**Restricción operativa:** Ciencias de la salud (57) y Magísteres (38) **no son enumerables en WhatsApp**. Para esos dos buckets el agente debe pedir palabra clave y hacer coincidencia sobre el nombre del programa, ofreciendo un máximo de 5 coincidencias. La enumeración directa solo aplica a buckets de ≤ 10 opciones.

### 11.3 Flujo por etapas

Preguntar los 15 campos de corrido genera abandono. La captura se divide en tres etapas con persistencia intermedia:

| Etapa | Campos | Resultado en Bitrix24 |
|---|---|---|
| **1 — Captura mínima** | Área, Programa, Nombre, Primer Apellido, E-mail, Teléfono | **Se crea la Negociación y el Contacto.** El lead ya no se pierde |
| **2 — Identificación** | RUT/DNI, Nacionalidad, Fecha de nacimiento, Segundo Apellido, Domicilio | Actualiza Contacto y Negociación |
| **3 — Antecedentes académicos** | Título/Grado, Institución, Año de egreso, Cédula | Completa Negociación y adjunta documento |

**Reglas de flujo:**

- Un dato por mensaje. No pedir dos campos en la misma pregunta.
- Confirmar E-mail y RUT repitiéndolos al usuario antes de guardar.
- Si el usuario abandona, la Negociación queda con los datos de la etapa alcanzada y se marca el punto de corte para retomar.
- Al retomar, no repreguntar lo ya capturado: confirmar y continuar.
- Máximo 2 reintentos por campo con validación fallida; al tercero, derivar a Postmatrículas (sección 4).

### 11.4 Adjunto de cédula de identidad

| Parámetro | Definición | Estado |
|---|---|---|
| Formatos aceptados | JPG, PNG, PDF | ⬜ POR CONFIRMAR |
| ¿Ambos lados de la cédula? | — | ⬜ POR CONFIRMAR |
| Tamaño máximo | — | ⬜ POR CONFIRMAR |
| Destino de almacenamiento | Bitrix24 Drive, adjunto a la Negociación | ⬜ POR CONFIRMAR |
| Validación de legibilidad | El agente **no** valida contenido ni hace OCR en Fase 1 | Propuesto |
| Extranjeros sin cédula chilena | ¿Se acepta pasaporte? | ⬜ POR CONFIRMAR |

### 11.5 Tratamiento de datos personales

La etapa 2 y 3 capturan RUT, fecha de nacimiento, domicilio y una imagen del documento de identidad. Antes de habilitar la captura conversacional debe definirse:

| Punto | Estado |
|---|---|
| Texto de consentimiento informado y momento en que se solicita | ⬜ POR CONFIRMAR |
| Registro del consentimiento como campo en la Negociación | ⬜ POR CONFIRMAR |
| Política de retención del archivo de cédula | ⬜ POR CONFIRMAR |
| Enmascaramiento del RUT en logs y transcripciones del chat | ⬜ POR CONFIRMAR |
| Validación con el área legal / compliance de la Universidad | ⬜ POR CONFIRMAR |

> No soy la instancia para definir el marco legal aplicable; corresponde validarlo con el área legal de la Universidad antes de capturar documentos de identidad por WhatsApp.

### 11.6 Brechas detectadas en el formulario actual

| Brecha | Impacto |
|---|---|
| El bucket **Máster** no existe en el selector de área | 2 programas activos quedan fuera: `MAG-INV-187` (Emergencia y Desastre) y `MAG-SEA-188` (Sexología) |
| No hay campo de **sede** | 8 programas existen en Santiago y Temuco con el mismo nombre (Neurociencias, Endodoncia, Implantología, Rehabilitación Oral, Odontopediatría). Sin sede la Negociación queda ambigua |
| No hay campo de **versión / mes de inicio** | Varios diplomados tienen hasta 7 versiones al año. Sin este dato no se puede asignar el flujo correcto |
| No se captura **origen del lead** | Necesario para atribución en Meta Ads |

---

## 10. Checklist de activación de la capa

| # | Dato | Responsable sugerido | Estado |
|---|---|---|---|
| 1 | Condiciones Toku: cuotas por tipo de programa | Frank (finanzas) | ✅ Diplomado 5 / Magíster 24 |
| 2 | Medios de pago | Frank | ✅ Débito y crédito |
| 3 | Área de destino para deuda / matrícula / beca (Banner) | Dirección Postgrados | ✅ Postmatrículas + formulario web |
| 4 | Área de destino para reclamos y soporte técnico | Dirección Postgrados | ✅ Postmatrículas + formulario web (SLA 2 días) |
| 5 | Cuotas para Máster y Especialidad Odontológica | Frank | ⬜ |
| 6 | ¿La matrícula entra en el plan de cuotas? | Frank | ⬜ |
| 7 | ¿Las cuotas tienen interés? / monto mínimo de cuota | Frank | ⬜ |
| 8 | Vigencia y acumulabilidad del descuento institucional | Johan (comercial) | ⬜ |
| 9 | Tabla de beneficios vigentes (sección 5) | Johan | ⬜ |
| 10 | Patrón de URL de ficha de programa y formulario de postulación | Marketing | ⬜ |
| 11 | Links portal estudiante / certificados / reglamento | Dirección Postgrados | ⬜ |
| 12 | Confirmación de precios de programas nuevos (sección 8) | Comercial | ⬜ |
| 13 | Reglas de adjunto de cédula (sección 11.4) | Franco Rojas | ⬜ |
| 14 | Consentimiento de datos personales (sección 11.5) | Legal / Dirección | ⬜ |
| 15 | Campos faltantes: sede, versión, bucket Máster (sección 11.6) | Franco Rojas | ⬜ |

**Estado general:** los cuatro bloqueantes de producción (pagos y derivación) están cerrados. Los pendientes 5 a 7 limitan la precisión de la respuesta sobre cuotas en 8 programas (2 Máster + 6 Especialidad) y en el detalle fino del plan de pago; los pendientes 8 a 12 son de alcance comercial y no impiden operar la Fase 1.