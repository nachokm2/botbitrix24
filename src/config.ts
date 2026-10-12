import 'dotenv/config';
import { marca } from './marca'; // marca.ts no importa nada: no hay ciclo

// Mapa de etapas por embudo para el movimiento por score, ej:
// {"1":{"alto":"C1:PREPARATION","medio":"C1:UC_JARL1O"},"3":{"alto":"C3:PREPAYMENT_INVOICE","medio":"C3:PREPARATION"}}
function parseStageMap(s?: string): Record<string, { alto?: string; medio?: string }> {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// Extrae el origin (scheme+host+port) de una URL completa, para comparar contra el header Origin.
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

// Mapa simple embudo→etapa (un solo STAGE_ID por embudo), ej: {"1":"C1:UC_ABC","3":"C3:UC_XYZ"}
function parseSimpleStageMap(s?: string): Record<string, string> {
  if (!s) return {};
  try {
    const p = JSON.parse(s);
    return p && typeof p === 'object' ? p : {};
  } catch {
    return {};
  }
}

// Etiquetas de embudo por CATEGORY_ID. Default: 0=General, 1=Diplomados, 3=Magísteres.
function parseFunnelLabels(s?: string): Record<string, string> {
  const def = { '0': 'General', '1': 'Diplomados', '3': 'Magísteres' };
  if (!s) return def;
  try {
    const p = JSON.parse(s);
    return p && typeof p === 'object' && Object.keys(p).length ? p : def;
  } catch {
    return def;
  }
}

export type MarchaBlancaPrograma = {
  key: string;
  nombre: string;
  /** Substring (ILIKE / Bitrix "%") para identificar el programa en texto libre capturado por el bot. */
  match: string;
  /** Substring a EXCLUIR (evita confundir con un programa homónimo, ej. "...y Derecho"). */
  exclude?: string;
  asesorNorte?: string;
  asesorSur?: string;
  /** ID de usuario Bitrix de cada asesor — para asignar directo (round-robin) y crear su tarea de
   *  seguimiento al escalar (ver crm/asignacionAsesores.ts). Sin ambos IDs, ese mecanismo no aplica
   *  para este programa (se sigue mostrando el nombre en el panel, solo no se auto-asigna). */
  asesorNorteId?: number;
  asesorSurId?: number;
  /** CATEGORY_ID (embudo) del Deal en Bitrix — acota la búsqueda ANTES del filtro de texto en el UF
   *  de programa (evita OPERATION_TIME_LIMIT: sin esto, crm.deal.list escanea TODO el portal). */
  categoryId: number;
};

// Programas del piloto ("marcha blanca") a medir en el panel. Configurable por si cambian sin tocar
// código; el default son los 2 programas confirmados para el piloto (ver conversación de lanzamiento).
// marca.ts no importa nada: no hay ciclo.
function parseMarchaBlancaProgramas(s?: string): MarchaBlancaPrograma[] {
  const def: MarchaBlancaPrograma[] = [
    {
      key: 'terapia_familiar',
      nombre: 'Diplomado en Intervención Terapéutica Familiar',
      match: 'Terapéutica Familiar',
      asesorNorte: 'Joaquín Retamal',
      asesorNorteId: 9,
      asesorSur: 'Eduardo Arias',
      asesorSurId: 346393,
      categoryId: 1, // Diplomados
    },
    {
      key: 'ia',
      nombre: 'Diplomado en Inteligencia Artificial',
      match: 'Inteligencia Artificial',
      exclude: 'Derecho', // no confundir con "Diplomado en Inteligencia Artificial y Derecho"
      asesorNorte: 'Zaida Verdugo',
      asesorNorteId: 283901,
      asesorSur: 'Constanza Huitraiqueo Garabito',
      asesorSurId: 368819,
      categoryId: 1, // Diplomados
    },
  ];
  // Sin la variable, el default SOLO vale para Postgrados: son sus 2 diplomados piloto, con sus
  // asesores y su embudo. Antes se aplicaba a cualquier marca, así que el panel de Carver mostraba
  // la proyección del correo de lanzamiento de Postgrados y una tabla con "Intervención Terapéutica"
  // e "Inteligencia Artificial" — programas que Carver no dicta.
  if (!s) return marca.key === 'postgrados' ? def : [];
  try {
    const p = JSON.parse(s);
    // Un [] explícito significa "sin piloto" y debe respetarse; antes también caía al default.
    return Array.isArray(p) ? p : def;
  } catch {
    return def;
  }
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  /** URL pública del app (Railway o túnel), sin slash final. */
  baseUrl: (process.env.BASE_URL ?? '').replace(/\/$/, ''),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
  classifierModel: process.env.ANTHROPIC_CLASSIFIER ?? 'claude-haiku-4-5',
  // STT (voz-a-texto) para transcribir los audios que el cliente manda por WhatsApp. Sin esta key, los
  // audios no se transcriben (se responde pidiendo el mensaje por texto). Deepgram nova-2 (español).
  deepgramApiKey: process.env.DEEPGRAM_API_KEY ?? '',
  deepgramModel: process.env.DEEPGRAM_MODEL ?? 'nova-2',
  bitrixWebhookUrl: (process.env.BITRIX_WEBHOOK_URL ?? '').replace(/\/$/, ''),
  botCode: process.env.BOT_CODE ?? 'poc_agente_postgrados',
  // OAuth de la app local (para renovar el access_token cuando expira).
  bitrixClientId: process.env.BITRIX_CLIENT_ID ?? '',
  bitrixClientSecret: process.env.BITRIX_CLIENT_SECRET ?? '',
  // application_token que Bitrix envía en cada evento/instalación (verificación de origen del webhook).
  bitrixAppToken: process.env.BITRIX_APPLICATION_TOKEN ?? '',
  // Secretos propios del backend para proteger paneles (DASHBOARD_TOKEN) y utilidades admin (ADMIN_TOKEN).
  dashboardToken: process.env.DASHBOARD_TOKEN ?? '',
  adminToken: process.env.ADMIN_TOKEN ?? '',
  // Fallback de BOT_ID (el storage de Railway es efímero entre deploys).
  botId: process.env.BITRIX_BOT_ID ? Number(process.env.BITRIX_BOT_ID) : undefined,
  // Persistencia (opcionales; si faltan, se usa memoria/no-op).
  redisUrl: process.env.REDIS_URL ?? '',
  databaseUrl: process.env.DATABASE_URL ?? '',
  pgSsl: process.env.PGSSL === 'true',
  // Códigos de campos personalizados (UF) opcionales para guardar el scoring en el CRM (en el Deal/Negociación).
  ufScore: process.env.BITRIX_UF_SCORE ?? '',
  ufIntent: process.env.BITRIX_UF_INTENT ?? '',
  ufSentiment: process.env.BITRIX_UF_SENTIMENT ?? '',
  // Campo UF (en el Deal) para el "Programa de interés" que el bot actualiza según la conversación.
  ufPrograma: process.env.BITRIX_UF_PROGRAMA ?? '',
  // Campo UF tipo "Archivo" (en el Deal) con el brochure (PDF del Drive) del programa de interés —
  // para que la automatización de "Información enviada" (Bitrix24) lo adjunte al correo. Se
  // actualiza junto con ufPrograma (ver crm/driveBrochure.ts).
  ufBrochureFile: process.env.BITRIX_UF_BROCHURE_FILE ?? '',
  // Slots adicionales para adjuntar los brochures como archivos SEPARADOS (no fusionados) cuando
  // hay varios programas de interés — el 1º programa va al de arriba, el 2º acá, el 3º acá. Si se
  // acumulan más programas que slots, los que sobran se fusionan en el ÚLTIMO slot disponible.
  ufBrochureFile2: process.env.BITRIX_UF_BROCHURE_FILE_2 ?? '',
  ufBrochureFile3: process.env.BITRIX_UF_BROCHURE_FILE_3 ?? '',
  // Campo UF tipo "Archivo" (en el Deal) "Cedula de identidad CL" — el bot lo sube cuando el cliente
  // envía la foto de su cédula por WhatsApp durante el proceso de matrícula (ver ai/toolRunner.ts:
  // registrar_documento_identidad). Campo real ya existente en el portal (UF_CRM_1709318371).
  ufCedula: process.env.BITRIX_UF_CEDULA ?? '',
  // Campo UF tipo "String" (en el Deal) con el cuerpo HTML del correo del brochure ya renderizado
  // por el bot (con TODOS los programas acumulados durante la conversación) — la plantilla bizproc
  // solo lo referencia vía {=Document:...}, sin necesitar loops nativos (ver crm/brochureEmail.ts).
  ufCuerpoBrochureHtml: process.env.BITRIX_UF_CUERPO_BROCHURE_HTML ?? '',
  // Etapa "Asignación" del embudo correcto según el TIPO de programa (magíster/diplomado) —
  // mover el deal ahí dispara la regla de asignación de asesor por oferta que ya existe en
  // Bitrix24 (configurada por el equipo, fuera de este código). Sin esto, cuando Bitrix vincula un
  // deal por su cuenta lo deja en un embudo/etapa fijos que no coinciden con el programa real, y la
  // regla de asignación nunca corre — el deal queda sin asesor asignado.
  asignacionStageDiplomado: process.env.BITRIX_ASIGNACION_STAGE_DIPLOMADO ?? 'C1:NEW',
  asignacionStageMagister: process.env.BITRIX_ASIGNACION_STAGE_MAGISTER ?? 'C3:NEW',
  // Si un deal YA está en el embudo correcto pero NUNCA pasó por la etapa de Asignación (llegó ahí
  // por otro camino — auto-CRM nativo de Bitrix, campaña de marketing — sin disparar la regla de
  // asesor-por-oferta), se fuerza el movimiento UNA VEZ, pero solo si el deal fue creado hace menos
  // de esta cantidad de horas — evita mover hacia atrás un deal viejo que un asesor ya viene
  // trabajando de verdad (bug real: deal #3490881 quedó sin el asesor correcto por esto).
  asignacionForzarVentanaHoras: Number(process.env.ASIGNACION_FORZAR_VENTANA_HORAS ?? 6),
  // Plazo (horas) de la tarea que se le crea al asesor asignado por turno cuando el bot escala a un
  // humano en uno de los 2 programas piloto (ver crm/asignacionAsesores.ts).
  asignacionTareaHoras: Number(process.env.ASIGNACION_TAREA_HORAS ?? 2),
  // IDs de las carpetas del Drive ("Brochures Bot/<tipo>") donde viven los PDF de cada tipo de programa.
  driveFolderMagister: process.env.BITRIX_DRIVE_FOLDER_MAGISTER ?? '',
  driveFolderDiplomado: process.env.BITRIX_DRIVE_FOLDER_DIPLOMADO ?? '',
  driveFolderEspecialidad: process.env.BITRIX_DRIVE_FOLDER_ESPECIALIDAD ?? '',
  // ID de la plantilla de Proceso de Negocio (bizproc) de Bitrix24 que envía el correo con el
  // brochure adjunto (actividad CrmSendEmailActivity, lee el programa/brochure directo del Deal).
  // El bot la dispara por API (bizproc.workflow.start) apenas adjunta un brochure nuevo — no
  // depende de mover etapas ni de una Automation Rule nativa.
  bizprocTemplateBrochure: process.env.BITRIX_BIZPROC_TEMPLATE_BROCHURE ?? '',
  // Contacto de admisión que se muestra en el correo (opcionales): link/número de WhatsApp y teléfono.
  admisionesWhatsapp: process.env.ADMISIONES_WHATSAPP ?? '',
  admisionesTelefono: process.env.ADMISIONES_TELEFONO ?? '',
  // Mover la etapa del deal según el score. Mapa por embudo (recomendado, multi-flujo):
  stageMap: parseStageMap(process.env.BITRIX_STAGE_MAP),
  // Etiquetas legibles por CATEGORY_ID de embudo, para el panel (C1=Diplomados, C3=Magísteres).
  funnelLabels: parseFunnelLabels(process.env.BITRIX_FUNNEL_LABELS),
  // Fallback de un solo embudo (legacy):
  stageScoreAlto: process.env.BITRIX_STAGE_SCORE_ALTO ?? '', // score >= 70
  stageScoreMedio: process.env.BITRIX_STAGE_SCORE_MEDIO ?? '', // score 40-69
  // Auto-escalar a humano si el score alcanza este umbral (0 = desactivado).
  scoreEscalar: Number(process.env.SCORE_ESCALAR ?? 80),
  // ── Seguimiento automático (WhatsApp): si el bot respondió y el cliente no volvió a escribir en
  // N horas, se le manda UN mensaje de seguimiento generado por IA. 0 = desactivado. Se cancela solo
  // si un humano toma la conversación (escalar_a_humano / operador). Requiere Redis (getRedisClient).
  seguimientoHoras: Number(process.env.SEGUIMIENTO_HORAS ?? 3),
  seguimientoIntervaloMin: Number(process.env.SEGUIMIENTO_INTERVALO_MIN ?? 10),
  // SEGUNDO (y último) recordatorio por IA, si tras el primero el cliente sigue sin responder —
  // medido desde la misma última respuesta del bot, así que debe ser mayor que SEGUIMIENTO_HORAS.
  // 0 = desactivado (solo un recordatorio).
  seguimientoSegundoHoras: Number(process.env.SEGUIMIENTO_SEGUNDO_HORAS ?? 10),
  // Si tras el recordatorio el cliente SIGUE sin responder hasta esta cantidad de horas (desde la
  // misma última respuesta del bot), se deriva el lead al asesor por turno (ver
  // crm/asignacionAsesores.ts) — no urgente, solo para contacto temprano. 0 = desactivado.
  seguimientoTransferenciaHoras: Number(process.env.SEGUIMIENTO_TRANSFERENCIA_HORAS ?? 4),
  // Horario permitido para ENVIAR el seguimiento proactivo (hora local Chile, 0-23). Si el plazo
  // cae fuera de esta ventana, se reprograma para el inicio de la ventana siguiente en vez de
  // mandarlo de madrugada. No afecta las respuestas normales del bot a mensajes del cliente.
  seguimientoHoraInicio: Number(process.env.SEGUIMIENTO_HORA_INICIO ?? 9),
  seguimientoHoraFin: Number(process.env.SEGUIMIENTO_HORA_FIN ?? 21),
  // Auto-LLAMAR por voz (Vapi) si el score alcanza este umbral (0 = desactivado). Ej: 50.
  scoreLlamar: Number(process.env.SCORE_LLAMAR ?? 0),
  // Sincronización de llamadas a Postgres (para KPIs exactos del período):
  callsSyncMinutes: Number(process.env.CALLS_SYNC_MINUTES ?? 0), // 0 = scheduler desactivado (se puede sincronizar manual)
  callsSyncSince: process.env.CALLS_SYNC_SINCE ?? '', // backfill inicial desde esta fecha ISO (vacío = últimos 90 días)
  // Retención de auditoría: borra audit_log más antiguo que N días (0 = desactivado, no borra nada).
  auditRetentionDays: Number(process.env.AUDIT_RETENTION_DAYS ?? 0),
  // ── Marcha blanca (piloto): fecha de arranque (para "leads antiguos" vs "nuevos") y programas a medir ──
  marchaBlancaStart: process.env.MARCHA_BLANCA_START ?? '2026-08-27',
  marchaBlancaProgramas: parseMarchaBlancaProgramas(process.env.MARCHA_BLANCA_PROGRAMAS),
  // IDs de usuario que son el responsable POR DEFECTO del embudo, no un asesor real: cualquier deal
  // que nadie reasigna queda en ellos (caso real: 3.599 deals de Diplomados en un solo usuario). Al
  // escalar, si el deal está en uno de estos, el bot lo corrige al asesor del programa; si lo tiene
  // cualquier otra persona, respeta esa asignación y no se mete. Vacío = nunca corrige.
  responsablesPorDefecto: (process.env.BITRIX_RESPONSABLES_POR_DEFECTO ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0),
  // Usuario de Bitrix al que se derivan TODAS las conversaciones, sin importar quién sea el
  // responsable de la negociación (0 = desactivado, y rige el reparto normal). Se usa cuando una
  // marca quiere un único punto de entrada humano: el bot le asigna el deal y le entrega el chat.
  derivarATodo: Number(process.env.BITRIX_DERIVAR_A ?? 0) || 0,
  // IDs de usuario que NO son personas sino automatizaciones de Bitrix (robots/reglas). El caso real
  // es #45 "Resp. Autom.", que barre a RMKT las negociaciones que nadie tocó: movió 31 de las 36
  // derivaciones del piloto. Se usa para no contar ese barrido como "el asesor tomó el caso" en la
  // columna de seguimiento (ver crm/marchaBlanca.ts). Vacío = todo movimiento cuenta como humano.
  usuariosAutomaticos: (process.env.BITRIX_USUARIOS_AUTOMATICOS ?? '45')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0),
  // Vigilancia de derivaciones: horas sin que nadie trabaje una negociación derivada antes de avisarle
  // al responsable por notificación interna de Bitrix. En el piloto de Postgrados, 4 de 38 casos
  // derivados fueron tomados por una persona; el resto lo barrió el robot a Remarketing sin que nadie
  // se enterara. 0 = desactivado.
  derivacionAlertaHoras: Number(process.env.DERIVACION_ALERTA_HORAS ?? 4) || 0,
  // Segundo aviso, al supervisor, si pasadas estas horas desde la derivación el caso sigue sin tomar.
  derivacionAlertaSupervisorHoras: Number(process.env.DERIVACION_ALERTA_SUPERVISOR_HORAS ?? 24) || 0,
  // Usuario de Bitrix que recibe ese segundo aviso (0 = no escalar, solo se avisa al responsable).
  derivacionSupervisorId: Number(process.env.BITRIX_SUPERVISOR_ID ?? 0) || 0,
  // Horas sin recibir UN SOLO mensaje, en horario hábil, antes de dar la alarma. El bot de
  // Postgrados estuvo cinco días mudo sin que nadie lo notara: no falló el código ni el servidor,
  // dejó de entregar el canal de WhatsApp, y por eso nada de lo que vigilábamos se quejó. 0 = off.
  canalSilencioHoras: Number(process.env.CANAL_SILENCIO_HORAS ?? 6) || 0,
  // Comprobación horaria de que los DOS caminos hacia Bitrix siguen vivos (webhook y OAuth). El
  // OAuth de Postgrados llevaba días sin poder renovarse y nada lo decía: las conversaciones
  // andaban, pero todo lo proactivo fallaba en silencio.
  vigilarSalud: (process.env.VIGILAR_SALUD ?? 'true').toLowerCase() !== 'false',
  // Umbrales del repunte de fallas de envío. Con poco volumen no significan nada: 1 de 1 es ruido.
  enviosTasaFallaAlerta: Number(process.env.ENVIOS_TASA_FALLA_ALERTA ?? 25) || 25,
  enviosMinimoParaAlertar: Number(process.env.ENVIOS_MINIMO_ALERTA ?? 10) || 10,
  // Modo copiloto: el bot redacta y el asesor envía. El cliente no recibe nada automático. Ataca el
  // problema de las derivaciones sin tomar por el lado contrario: en vez de pedirle trabajo al
  // asesor, entregárselo medio hecho. Apagado por defecto — cambia el comportamiento visible.
  copilotoActivo: (process.env.COPILOTO_ACTIVO ?? '').toLowerCase() === 'true',
  // Embudos donde aplica. Vacío = todos (con COPILOTO_ACTIVO=true).
  copilotoCategorias: (process.env.COPILOTO_CATEGORIAS ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '')
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0),
  // A quién van los borradores. 0 = al responsable de cada negociación.
  copilotoDestino: Number(process.env.COPILOTO_DESTINO ?? 0) || 0,
  // Hasta cuándo se consideran vigentes los precios y condiciones (YYYY-MM-DD). Pasada esa fecha el
  // bot sigue cotizando pero entrega el valor como referencia y ofrece confirmarlo. Vacío = sin
  // caducidad, que es el comportamiento anterior. Se actualiza cada vez que la dirección revalida.
  condicionesVigenciaHasta: process.env.CONDICIONES_VIGENCIA_HASTA ?? '',
  // Revisión automática de las conversaciones del día (ai/revisionDiaria.ts): hora de Chile a la que
  // corre. Todos los defectos del piloto se encontraron porque alguien leyó una conversación y notó
  // algo raro; nadie lee 70 al día. -1 = desactivada.
  revisionDiariaHora: process.env.REVISION_DIARIA_HORA ? Number(process.env.REVISION_DIARIA_HORA) : 22,
  // Tope de conversaciones por revisión: acota el costo (son llamadas al clasificador) y el tiempo.
  revisionMaxConversaciones: Number(process.env.REVISION_MAX_CONVERSACIONES ?? 40) || 40,
  // Resumen semanal empujado a Bitrix (ai/resumenSemanal.ts). El panel existe y está completo, pero
  // hay que acordarse de abrirlo: esto manda las cinco líneas que importan adonde la gente ya mira.
  // Vacío = no se manda a nadie.
  resumenSemanalDestinatarios: (process.env.RESUMEN_SEMANAL_USUARIOS ?? '')
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n) && n > 0),
  resumenSemanalDia: Number(process.env.RESUMEN_SEMANAL_DIA ?? 1), // 0 = domingo, 1 = lunes
  resumenSemanalHora: Number(process.env.RESUMEN_SEMANAL_HORA ?? 9), // hora de Chile
  // Primer contacto con los leads que entraron y nunca escribieron (crm/primerContacto.ts). En el
  // piloto entraron ~800 y el bot conversó con 81: los otros dejaron sus datos y nadie volvió a
  // hablarles. APAGADO por defecto y a propósito: escribir primero necesita plantilla aprobada por
  // Meta, una decisión de volumen y claridad sobre el consentimiento con que se recogieron los datos.
  primerContactoActivo: (process.env.PRIMER_CONTACTO_ACTIVO ?? '').toLowerCase() === 'true',
  // Una o varias plantillas separadas por coma. Con varias se reparten entre los destinatarios para
  // comparar cuál obtiene más respuestas — el único número del caso de negocio que no se puede
  // calcular de antemano. Se mantiene el nombre en singular por compatibilidad.
  primerContactoPlantillas: (process.env.PRIMER_CONTACTO_PLANTILLA ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
  primerContactoIdioma: process.env.PRIMER_CONTACTO_IDIOMA ?? 'es',
  primerContactoDias: Number(process.env.PRIMER_CONTACTO_DIAS ?? 7) || 7,
  primerContactoMaxDiario: Number(process.env.PRIMER_CONTACTO_MAX_DIARIO ?? 50) || 0,
  // Prefijo que se asume para un número guardado SIN código de país. Vacío = descartarlo en vez de
  // adivinar: en una marca internacional, asumir el país manda el mensaje a un desconocido.
  primerContactoPrefijoPais: process.env.PRIMER_CONTACTO_PREFIJO_PAIS ?? '+56',
  // Hora de Chile a la que sale la tanda diaria.
  primerContactoHora: Number(process.env.PRIMER_CONTACTO_HORA ?? 10),
  // Reactivación de conversaciones frías: gente que SÍ habló con el bot y se apagó. Pasadas las 24
  // horas de la última interacción WhatsApp no deja texto libre, así que necesita plantilla igual
  // que el primer contacto. Apagada por defecto, por los mismos motivos.
  reactivacionActiva: (process.env.REACTIVACION_ACTIVA ?? '').toLowerCase() === 'true',
  reactivacionPlantillas: (process.env.REACTIVACION_PLANTILLA ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
  reactivacionDiasMin: Number(process.env.REACTIVACION_DIAS_MIN ?? 3) || 3,
  reactivacionDiasMax: Number(process.env.REACTIVACION_DIAS_MAX ?? 45) || 45,
  reactivacionMaxDiario: Number(process.env.REACTIVACION_MAX_DIARIO ?? 30) || 0,
  reactivacionHora: Number(process.env.REACTIVACION_HORA ?? 11),
  // Orden de los parámetros de la plantilla, separados por coma. Tokens: nombre, asesor, programa,
  // organizacion. Cada plantilla aprobada tiene su propio orden de {{n}}, así que esto es
  // configuración: cambiar de plantilla no debería obligar a tocar el código.
  primerContactoParams: (process.env.PRIMER_CONTACTO_PARAMS ?? 'nombre,programa')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
  // ChatApp: el proveedor por el que entra y sale el WhatsApp de Carver (conector WACA de Canales
  // Abiertos). Un mensaje proactivo DEBE salir por el mismo número que escucha el bot; si sale por
  // otro, la persona responde donde nadie la lee.
  chatappEmail: process.env.CHATAPP_EMAIL ?? '',
  chatappPassword: process.env.CHATAPP_PASSWORD ?? '',
  chatappAppId: process.env.CHATAPP_APP_ID ?? '',
  chatappLicenseId: Number(process.env.CHATAPP_LICENSE_ID ?? 0) || 0,
  // Prefijos de país a los que SÍ se puede escribir, separados por coma (ej. "+56,+57,+593").
  // Vacío = sin restricción. Existe porque el CRM trae números mal cargados: en la muestra de
  // Carver apareció un "+94859…" que es un chileno al que le falta el 56, y con ese prefijo el
  // mensaje habría salido a Sri Lanka — y se habría pagado. Un número fuera de la lista se descarta.
  primerContactoPaises: (process.env.PRIMER_CONTACTO_PAISES ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => /^\+\d{1,4}$/.test(x))
    .sort((a, b) => b.length - a.length), // más largo primero: +593 debe ganarle a +59
  // Ojo con el orden: acá el 0 es un embudo VÁLIDO de Bitrix, así que no se puede descartar como en
  // las otras listas. Hay que quitar las cadenas vacías ANTES de convertir, o un valor sin definir
  // deja [0] y el filtro termina pidiendo las negociaciones del embudo equivocado.
  primerContactoCategorias: (process.env.PRIMER_CONTACTO_CATEGORIAS ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '')
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0),
  // Precio Anthropic por millón de tokens (USD) para estimar costo en el panel (0 = no mostrar).
  costInPerMtok: Number(process.env.ANTHROPIC_COST_IN_PER_MTOK ?? 0),
  costOutPerMtok: Number(process.env.ANTHROPIC_COST_OUT_PER_MTOK ?? 0),
  // Gasto real de Railway del mes (USD) para la tabla "Costos mensuales estimados" del piloto — a
  // diferencia del de Claude, no hay API para leerlo solo: se actualiza a mano desde el panel de
  // uso de Railway (Project → Usage) cada vez que se quiera refrescar el reporte. Vacío = no mostrar.
  costoUsdRailway: process.env.COSTO_USD_RAILWAY ? Number(process.env.COSTO_USD_RAILWAY) : null,
  // Fecha a la que corresponde ese gasto (YYYY-MM-DD). Railway no expone el costo por API, así que
  // el número se carga a mano y envejece sin aviso: el panel mostró 0,71 de principios de septiembre
  // durante más de un mes como si fuera el gasto actual. Mostrando la fecha, quien lo lee sabe qué
  // tan viejo es.
  costoUsdRailwayFecha: process.env.COSTO_USD_RAILWAY_FECHA ?? '',

  // ── Fase 2: Agente de voz (Vapi + Twilio + registro en telefonía Bitrix) ──
  // Vapi corre la conversación (STT/TTS/barge-in + Claude) y llama a nuestro backend por webhooks.
  vapiApiKey: process.env.VAPI_API_KEY ?? '', // API key privada de Vapi (para outbound / setup)
  vapiAssistantId: process.env.VAPI_ASSISTANT_ID ?? '',
  vapiPhoneNumberId: process.env.VAPI_PHONE_NUMBER_ID ?? '', // número (BYO Twilio) importado a Vapi
  vapiSecret: process.env.VAPI_SECRET ?? '', // server.secret: Vapi lo envía en header x-vapi-secret
  // ── WhatsApp Calling (patrón callback) ──
  // Phone-number de Vapi del trunk BYO de WhatsApp (0e5c23be → credential 68a49314 → SBC → wa.meta.vc).
  // Se usa para DEVOLVER la llamada al usuario que llamó por WhatsApp (la entrante no se puede atender
  // directo por un límite de media de Vapi; ver Arquitectura-WhatsApp-Calling). Vacío = usa vapiPhoneNumberId.
  vapiWhatsappPhoneNumberId:
    process.env.VAPI_WHATSAPP_PHONE_NUMBER_ID ?? '0e5c23be-a872-4556-bdbf-fc09309b00e7',
  // Secreto dedicado que el SBC Asterisk envía (?secret=) al golpear /whatsapp/inbound-call para
  // gatillar el callback. Menor privilegio: NO reutilizamos VAPI_SECRET en la VM. Fail-closed en prod.
  whatsappCallbackSecret: process.env.WHATSAPP_CALLBACK_SECRET ?? '',
  // Registro de la llamada en el CRM de Bitrix (telephony.externalCall.*):
  voiceUserId: Number(process.env.BITRIX_TELEPHONY_USER_ID ?? 0), // usuario Bitrix "dueño" de las llamadas
  voiceLineNumber: process.env.BITRIX_TELEPHONY_LINE ?? '', // nº de línea externa (opcional)
  // Destino de derivación a humano cuando no hay asesor asignado (número PSTN o SIP URI).
  voiceTransferFallback: process.env.VOICE_TRANSFER_FALLBACK ?? '',

  // ── Acciones de "lead caliente" cuando el agente de voz capta interés en un programa ──
  // Etapa a la que mover el Deal, por embudo: {"1":"C1:UC_XXX","3":"C3:UC_YYY"}.
  // Si no está, cae a config.stageMap[cat].alto (el mismo de scoring alto).
  voiceStageMap: parseSimpleStageMap(process.env.VOICE_STAGE_MAP),
  voiceStageInteresado: process.env.VOICE_STAGE_INTERESADO ?? '', // fallback de un solo embudo
  // Minutos de plazo (DEADLINE) de la tarea al asesor. Default 15.
  voiceTaskMinutes: Number(process.env.VOICE_TASK_MINUTES ?? 15),
  // Asesor por defecto para la tarea si el Deal no tiene responsable (o es un lead nuevo). 0 = no crear.
  voiceTaskUserId: Number(process.env.VOICE_TASK_FALLBACK_USER ?? 0),

  // Allowlist de orígenes permitidos para POST /webchat/message (defensa anti-abuso; ver ALT-Alta-2
  // de la auditoría). Vacío = sin restricción (comportamiento previo). Incluye siempre el propio
  // BASE_URL (el widget se sirve desde aquí mismo), más los que se agreguen en WEBCHAT_ALLOWED_ORIGINS.
  webchatAllowedOrigins: Array.from(
    new Set(
      [
        ...(process.env.BASE_URL ? [originOf(process.env.BASE_URL)] : []),
        ...(process.env.WEBCHAT_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()),
      ].filter(Boolean),
    ),
  ),

  // ── M4: canales Instagram/Messenger (Meta Graph API) ──
  // Verificación del webhook (handshake GET, hub.verify_token) — cualquier string que definas al suscribir el webhook en Meta.
  metaVerifyToken: process.env.META_VERIFY_TOKEN ?? '',
  // App Secret de la app de Meta: firma cada POST del webhook (X-Hub-Signature-256); verifica su origen.
  metaAppSecret: process.env.META_APP_SECRET ?? '',
  // Page Access Token (con scopes pages_messaging + instagram_basic + instagram_manage_messages):
  // se usa para enviar la respuesta por la Send API, tanto a Messenger como a Instagram.
  metaPageAccessToken: process.env.META_PAGE_ACCESS_TOKEN ?? '',
};
