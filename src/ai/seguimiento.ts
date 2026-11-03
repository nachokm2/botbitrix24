import { anthropic, CLASSIFIER } from './client';
import { getHistory, setHistory } from './memory';
import { transcript } from './briefing';
import { getSession, traspasoVigente } from '../session';
import { asesoresDisponibles, proximoFueraDeHorario } from '../core/horarioAsesores';
import { marca } from '../marca';
import { guardarRespuesta } from '../core/guardRespuesta';
import { URLS_OFICIALES_CARVER } from '../core/promptObjeciones';
import { callBitrix } from '../bitrix/client';
import { getRedisClient, getJson, setJson, kvDel } from '../store/kv';
import { getState } from '../store';
import { config } from '../config';
import { horarios } from '../core/ajustes';
import { recordTokens, inc } from '../obs/metrics';
import { audit } from '../obs/audit';
import { log } from '../log';
import { asignarAsesorPorTurno, derivarAResponsableFijo } from '../crm/asignacionAsesores';
import { derivacionYaGestionada } from '../crm/embudos';
import { estaExcluido } from '../crm/exclusion';
import { listaBlancaActiva, puedeResponder } from '../core/listaBlanca';
import type { Auth } from '../store';
import { vigilarDerivacion, barrerVigilanciaDerivaciones } from '../crm/vigilanciaDerivaciones';
import { primaryEntity, type CrmEntities } from '../crm/entities';
import { getIdentidadAsesor } from '../crm/directory';

// Seguimiento automático (WhatsApp/Open Lines) en 3 etapas, si el bot respondió y el cliente quedó
// en silencio — las TRES ancladas a la MISMA última respuesta del bot (no una después de la otra):
//  1) A las SEGUIMIENTO_HORAS (ej. 3h): se le manda UN mensaje de seguimiento (generado por IA a
//     partir de la propia conversación) — ver barrerSeguimientosVencidos.
//  2) A las SEGUIMIENTO_TRANSFERENCIA_HORAS (más tarde, ej. 4h): si el cliente SIGUE sin responder
//     (ni siquiera al recordatorio), se deriva el lead al asesor asignado por turno + se crea una
//     tarea — ver barrerTransferenciasVencidas. NO es una transferencia urgente (no se silencia al
//     bot ni se toma la sesión de Open Lines): es solo para que un humano pueda contactarlo temprano
//     por su cuenta; si el cliente vuelve a escribir, el bot le sigue respondiendo normal.
//  3) A las SEGUIMIENTO_SEGUNDO_HORAS (ej. 10h): ÚLTIMO recordatorio por IA, con otro tono (cierra
//     dejando la puerta abierta en vez de volver a preguntar lo mismo) — ver
//     barrerSegundosRecordatoriosVencidos. Va después de la derivación a propósito: el asesor ya
//     tiene el lead, pero el bot le da una última oportunidad de retomar por su cuenta.
// Si el cliente responde en cualquier momento, botEvents.ts vuelve a llamar a programarSeguimiento
// tras la respuesta del bot, lo que reprograma (o cancela, ver más abajo) ambas etapas desde cero.
//
// Se agenda con 3 ZSETs en Redis (dialogId -> vencimiento) que un barrido periódico recorre — mismo
// patrón que store/db.ts:startRetentionSweep. Solo WhatsApp: es el único canal donde el bot puede
// escribirle a alguien por iniciativa propia (Web Chat/Instagram/Messenger no tienen una forma de
// "empujar" un mensaje al visitante fuera de una respuesta), y el único con deals reales a los que
// asignar un asesor por turno.
//
// SECUENCIA POR ETAPAS (SEGUIMIENTO_ETAPAS_HORAS; Carver desde el 03-11-2026). En vez de los dos
// recordatorios fijos, N mensajes: el primero retoma el hilo, los del medio buscan una respuesta
// fácil (sí, no, una palabra) y el último cierra con el WhatsApp y el correo del asesor a cargo, para
// que si después lo contacta por fuera no le escriba un desconocido. Cada chat tiene UN solo paso
// pendiente a la vez (PASOS_KEY) y su plan guardado (PLAN_KEY): dos pasos no pueden dispararse en el
// mismo barrido, que es como llegaban dos recordatorios con un minuto de diferencia.

const DUE_KEY = 'seguimiento:due';
const SEGUNDO_KEY = 'seguimiento:segundo:due';
const TRANSFER_KEY = 'seguimiento:transferencia:due';
const ENTITIES_TTL_SEC = 2 * 24 * 3600; // cubre holgado el plazo de la transferencia (la única etapa que los usa)
const TIMEZONE = 'America/Santiago';

const ENTITIES_KEY = (dialogId: string) => `seguimiento:entidades:${dialogId}`;
// Instantánea de la conversación al programar la secuencia. La memoria del chat (ai/memory.ts) vence
// a las 6 h y el último recordatorio se programa a las 10: sin esta copia lo encontraba vacía y se
// descartaba EN SILENCIO. En el piloto de Carver se enviaron 100+ primeros recordatorios y CERO
// segundos (logs del 10 al 13 de octubre de 2026), aunque el segundo estaba configurado.
const SNAPSHOT_KEY = (dialogId: string) => `seguimiento:snapshot:${dialogId}`;
const SNAPSHOT_TTL_SEC = 2 * 24 * 3600;
// Último recordatorio enviado, para saber si la persona RESPONDIÓ a él (no basta con haberlo enviado).
const ULTIMO_KEY = (dialogId: string) => `seguimiento:ultimo:${dialogId}`;
// Envíos proactivos de las últimas 24 h, para el tope diario.
const ENVIADOS_KEY = (dialogId: string) => `seguimiento:enviados:${dialogId}`;
// WhatsApp solo admite mensajes libres dentro de las 24 h desde el último mensaje del cliente. Se deja
// margen: un recordatorio que sale después no llega, aunque Bitrix lo acepte.
const VENTANA_WHATSAPP_MS = 23.5 * 3600_000;

const PASOS_KEY = 'seguimiento:pasos:due';
const PLAN_KEY = (dialogId: string) => `seguimiento:plan:${dialogId}`;
const PLAN_TTL_SEC = 2 * 24 * 3600;
// Entre dos recordatorios de la secuencia, como mínimo. Cuando la noche corre varios a la mañana,
// sin esto saldrían todos juntos a las 9:00.
const SEPARACION_MIN_MS = 2 * 3600_000;

type Snapshot = { transcript: string; clienteAt: number; sesion: string | null };
/** `id` es el instante en que se programó: distingue esta secuencia de la que la reemplace si el
 *  cliente responde mientras un paso se está enviando. */
type Plan = { id: number; pasos: number[]; siguiente: number };
type TipoRecordatorio = 'primero' | 'intermedio' | 'cierre';

function tipoDeEtapa(etapa: number, total: number): TipoRecordatorio {
  if (etapa === 1) return 'primero';
  return etapa >= total ? 'cierre' : 'intermedio';
}

const TONO_SEGUIMIENTO = `Escribe en español de Chile, tratando siempre de "usted" (nunca tuteas ni voseas). No inventes datos ni programas, no uses un saludo formal tipo "Estimado/a", y no empieces con "Oye" ni otras muletillas informales similares ("Ey", "Oiga"). NUNCA uses voseo chileno ("cómo estai", "cachai", "teni") ni jerga de calle: representas a una universidad — cercano pero profesional, como corresponde a una asesora. Devuelve SOLO el mensaje, sin comillas ni explicación.`;

// La identidad del recordatorio sale de la marca. Estaba fija en "Sofía, asesora de Postgrados de la
// Universidad Autónoma de Chile" también para Carver: el seguimiento le hablaba al cliente con otra
// identidad y en el mismo chat nombraba al asesor en tercera persona ("coordinar con Ignacio").
// La reunión de Carver del 02-11-2026 marcó "veo que quedamos en…" como la frase que delata a la IA.
const TONO_SEGUIMIENTO_ASESOR = `Escribe en ${marca.espanol}, tratando siempre de "usted". Sin saludo formal tipo "Estimado/a", sin negritas, sin enlaces y sin cifras ni costos. Habla directo, como una persona: nada de fórmulas como "veo que quedamos en", "retomando nuestra conversación" o "le escribo para hacer seguimiento". No inventes datos ni programas. Devuelve SOLO el mensaje, sin comillas ni explicación.`;

const recordatorios = (n: number) => (n === 1 ? 'UN recordatorio' : `${n} recordatorios`);

/** Prompt del recordatorio según su lugar en la secuencia: el primero retoma el hilo, los del medio
 *  buscan una respuesta fácil y el último cierra dejando la puerta abierta — si mandara otra vez
 *  "¿te quedaron dudas?" se leería como insistencia, que es justo lo que molesta a alguien que ya
 *  decidió no responder. `conContacto`: al cierre se le agregan después el WhatsApp y el correo del
 *  asesor, así que el modelo no debe escribirlos (ni inventarlos). */
function sistemaSeguimiento(tipo: TipoRecordatorio, etapa: number, conContacto = false): string {
  if (marca.sePresentaComoAsesor) {
    const baseAsesor =
      `Eres el asesor a cargo de esta conversación en ${marca.organizacion}; ya te presentaste antes. El cliente no ha ` +
      'respondido desde tu último mensaje. NO vuelvas a presentarte ni digas tu nombre, y NO nombres a otras personas del ' +
      'equipo: el seguimiento lo haces tú, en primera persona.';
    if (tipo === 'primero') {
      return `${baseAsesor} Escribe UN mensaje de seguimiento breve (1 a 2 frases), cálido y natural: retoma el hilo (el programa o tema del que hablaban) y ofrece seguir ayudando. No repitas algo que ya dijiste. ${TONO_SEGUIMIENTO_ASESOR}`;
    }
    if (tipo === 'intermedio') {
      return `${baseAsesor} Ya le escribiste ${recordatorios(etapa - 1)} y sigue sin responder. Escribe UN mensaje muy breve (una frase, máximo dos) que le haga fácil contestar: una pregunta concreta que se responda con sí, no o una palabra, sobre el programa o el siguiente paso. Que no se parezca a tus mensajes anteriores, y NO presiones con urgencia, cupos ni descuentos. ${TONO_SEGUIMIENTO_ASESOR}`;
    }
    const contacto = conContacto
      ? ' NO escribas teléfonos ni correos: tu WhatsApp y tu correo se agregan al final del mensaje.'
      : '';
    return `${baseAsesor} Ya le escribiste ${recordatorios(etapa - 1)} y tampoco respondió: este es el ÚLTIMO mensaje. Escribe UNA frase que cierre con elegancia: entiende que puede tener poco tiempo o que no sea el momento, y deja la puerta abierta ("quedo atento cuando quiera retomarlo").${contacto} NO insistas, NO repitas los recordatorios anteriores y NO presiones con urgencia, cupos ni descuentos. ${TONO_SEGUIMIENTO_ASESOR}`;
  }
  const base = 'Eres Sofía, asesora comercial de Postgrados de la Universidad Autónoma de Chile. El cliente no ha respondido desde tu último mensaje.';
  if (tipo === 'primero') {
    return `${base} Escribe UN mensaje de seguimiento breve (1 a 3 frases), cálido y natural: retoma el hilo de la conversación (el programa o tema del que hablaban) y ofrece seguir ayudando. No repitas literalmente algo que ya dijiste. ${TONO_SEGUIMIENTO}`;
  }
  if (tipo === 'intermedio') {
    return `${base} Ya le escribiste ${recordatorios(etapa - 1)} y sigue sin responder. Escribe UN mensaje muy breve (una frase, máximo dos) que le haga fácil contestar: una pregunta concreta que se responda con sí, no o una palabra. No repitas los mensajes anteriores y NO presiones con urgencia, cupos ni descuentos. ${TONO_SEGUIMIENTO}`;
  }
  return `${base} Ya le escribiste UN recordatorio hace varias horas y tampoco respondió: este es el ÚLTIMO mensaje que le enviarás. Escribe UN mensaje breve (1 a 2 frases) que cierre con elegancia: entiende que puede no ser el momento, deja la puerta abierta para cuando quiera retomar y menciona que un asesor queda disponible. NO insistas, NO vuelvas a preguntar "¿te quedaron dudas?" ni repitas el recordatorio anterior, y NO presiones con urgencia, cupos ni descuentos. ${TONO_SEGUIMIENTO}`;
}

/** +56912345678 → "+56 9 1234 5678", como se escribe un celular chileno; los demás quedan igual. */
export function formatearTelefono(e164: string): string {
  const m = /^\+569(\d{4})(\d{4})$/.exec(e164);
  return m ? `+56 9 ${m[1]} ${m[2]}` : e164;
}

/** La frase con el WhatsApp y el correo del asesor a cargo, para el último recordatorio. Solo lo que
 *  la coordinación entregó (crm/contactoAsesores.ts) o un correo del dominio oficial: el Gmail
 *  personal de la ficha de Bitrix no se le da a un cliente. Vacía si no hay nada que dar, o si la
 *  marca no habla como el asesor (Postgrados habla como Sofía: "mi WhatsApp" no sería de nadie). */
export async function contactoParaElCierre(dialogId: string, auth: Auth): Promise<string> {
  if (!marca.sePresentaComoAsesor) return '';
  const ents = await getJson<CrmEntities>(ENTITIES_KEY(dialogId));
  if (!ents || !(ents.deal || ents.lead || ents.contact)) return '';
  const a = await getIdentidadAsesor(ents, auth).catch(() => null);
  if (!a) return '';
  const dominio = config.dominioCorreoOficial ? `@${config.dominioCorreoOficial}` : '';
  const email = a.email && (!dominio || a.email.toLowerCase().endsWith(dominio)) ? a.email : '';
  const whatsapp = a.telefono ? formatearTelefono(a.telefono) : '';
  const datos = [whatsapp && `mi WhatsApp ${whatsapp}`, email && `mi correo ${email}`].filter(Boolean).join(' y ');
  return datos ? `Le dejo ${datos}, por si le acomoda más escribirme por ahí.` : '';
}

/** Hora local (0-23) de Chile para un instante dado — usa Intl.DateTimeFormat en vez de aritmética
 *  manual de offset para que el cambio de horario de verano/invierno quede resuelto solo. */
export function horaEnChile(fecha: Date): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, hour: 'numeric', hour12: false }).format(fecha));
}

/** Si `fecha` cae dentro de la franja de mensajes automáticos (ajustes.horarios(), hora Chile), la
 *  devuelve tal cual. Si no, avanza hora a hora hasta la próxima hora permitida — evita
 *  mandar el seguimiento proactivo de madrugada (esto NO afecta las respuestas normales del bot a
 *  mensajes del cliente, que son inmediatas a cualquier hora). */
export function proximoHorarioPermitido(fecha: Date): Date {
  let t = fecha;
  const { automaticosHoraInicio, automaticosHoraFin } = horarios();
  // Dos condiciones a la vez: la ventana de seguimiento (no escribir de madrugada) y el horario de
  // asesores (no escribir mientras ellos atienden). Se alternan hasta que se cumplen las dos,
  // porque corregir una puede volver a romper la otra: salir de la jornada a las 18:30 cae dentro
  // de la ventana, pero correr al día siguiente a las 9:00 vuelve a caer en jornada.
  for (let vuelta = 0; vuelta < 10; vuelta++) {
    let movido = false;
    for (let i = 0; i < 24; i++) {
      const h = horaEnChile(t);
      if (h >= automaticosHoraInicio && h < automaticosHoraFin) break;
      t = new Date(t.getTime() + 3600_000);
      movido = true;
    }
    const fuera = proximoFueraDeHorario(t);
    if (fuera.getTime() === t.getTime() && !movido) return t;
    if (fuera.getTime() !== t.getTime()) {
      t = fuera;
      continue;
    }
    if (!asesoresDisponibles(t)) return t;
  }
  return t;
}

/** El último instante en que se puede escribir, sin pasar de `hasta` ni llegar a `desde`; null si no
 *  hay ninguno. Es proximoHorarioPermitido al revés, en pasos de 10 minutos. */
function ultimoHorarioPermitidoHasta(hasta: number, desde: number): number | null {
  for (let t = hasta; t > desde; t -= 10 * 60_000) {
    if (proximoHorarioPermitido(new Date(t)).getTime() === t) return t;
  }
  return null;
}

/** Cuándo sale cada recordatorio de la secuencia por etapas, contando desde `desde` (la última
 *  respuesta del bot, que abre la ventana de 24 h de WhatsApp):
 *  - El último va a la hora de su etapa o ANTES, si a esa hora no se puede escribir: corrido hacia
 *    adelante quedaría fuera de la ventana y WhatsApp no lo entregaría, y es el que lleva el
 *    contacto del asesor.
 *  - Los anteriores van a su hora o, si cae de noche, a la mañana siguiente, siempre a
 *    SEPARACION_MIN_MS del anterior.
 *  - El que ya no cabe antes del último se omite: mejor cuatro mensajes que dos pegados.
 *  Con una sola etapa es el recordatorio de siempre: a su hora o a la próxima permitida. */
export function planDeRecordatorios(desde: number, horas: number[]): number[] {
  if (!horas.length) return [];
  const horaFinal = Math.min(horas[horas.length - 1], VENTANA_WHATSAPP_MS / 3600_000);
  if (horas.length === 1) return [proximoHorarioPermitido(new Date(desde + horaFinal * 3600_000)).getTime()];
  const ultimo = ultimoHorarioPermitidoHasta(desde + horaFinal * 3600_000, desde);
  const pasos: number[] = [];
  let previo = Number.NEGATIVE_INFINITY;
  for (const h of horas.slice(0, -1)) {
    const t = proximoHorarioPermitido(new Date(Math.max(desde + h * 3600_000, previo + SEPARACION_MIN_MS))).getTime();
    if (ultimo === null ? t - desde > VENTANA_WHATSAPP_MS : t > ultimo - SEPARACION_MIN_MS) break;
    pasos.push(t);
    previo = t;
  }
  if (ultimo !== null && ultimo > Math.max(previo, desde)) pasos.push(ultimo);
  return pasos;
}

/** Programa (o reprograma) las 3 etapas del seguimiento de un diálogo, todas desde AHORA (se llama
 *  tras cada respuesta del bot, así que el plazo siempre corre desde la ÚLTIMA vez que el bot
 *  habló): el recordatorio a SEGUIMIENTO_HORAS, la transferencia al asesor a
 *  SEGUIMIENTO_TRANSFERENCIA_HORAS y el último recordatorio a SEGUIMIENTO_SEGUNDO_HORAS. Si esos
 *  plazos caen fuera del horario permitido, se corren al inicio de la próxima ventana. Con
 *  SEGUIMIENTO_ETAPAS_HORAS, en cambio, programa la secuencia por etapas (ver planDeRecordatorios).
 *  `entities` (si se pasa) queda guardado para que la transferencia sepa a qué deal/lead asignar, y
 *  el último paso de la secuencia de quién es el contacto — normalmente ya lo tiene resuelto quien
 *  llama (ver botEvents.ts). No hace nada si la regla está desactivada, si no hay Redis, o si un
 *  humano ya tomó la conversación. */
export async function programarSeguimiento(dialogId: string, entities?: CrmEntities, sesionActual?: string | null): Promise<void> {
  const r = getRedisClient();
  if (!r || config.seguimientoHoras <= 0) return;
  try {
    const sess = await getSession(dialogId);
    if (sess.humanTookOver) return;
    const ahora = Date.now();
    // Se programa justo después de que el bot respondió a un mensaje del cliente: este instante marca
    // también el inicio de la ventana de 24 h de WhatsApp.
    const t = config.seguimientoInstantanea ? transcript(await getHistory(dialogId)) : '';
    if (t.length >= 5) {
      await setJson(SNAPSHOT_KEY(dialogId), { transcript: t, clienteAt: ahora, sesion: sesionActual ?? null } satisfies Snapshot, SNAPSHOT_TTL_SEC);
    }
    inc('seguimiento_programado');
    if (config.seguimientoEtapasHoras.length) {
      // Secuencia por etapas: se guarda el plan entero y queda pendiente solo el primer paso; cada
      // envío agenda el siguiente (ver avanzarPlan). Las colas de los dos recordatorios fijos no
      // corren junto a ella: limpiarlas aquí también vacía lo que quedó agendado antes del cambio.
      const pasos = planDeRecordatorios(ahora, config.seguimientoEtapasHoras);
      await r.zrem(DUE_KEY, dialogId).catch(() => {});
      await r.zrem(SEGUNDO_KEY, dialogId).catch(() => {});
      // El último paso lleva el contacto del asesor a cargo: hace falta saber de qué negociación es,
      // haya o no derivación por silencio.
      if (entities && Object.keys(entities).length) await setJson(ENTITIES_KEY(dialogId), entities, ENTITIES_TTL_SEC);
      if (pasos.length) {
        await setJson(PLAN_KEY(dialogId), { id: ahora, pasos, siguiente: 0 } satisfies Plan, PLAN_TTL_SEC);
        await r.zadd(PASOS_KEY, pasos[0], dialogId);
      } else {
        await r.zrem(PASOS_KEY, dialogId).catch(() => {});
      }
      if (config.seguimientoTransferenciaHoras > 0 && pasos.length) {
        const deltaHoras = Math.max(config.seguimientoTransferenciaHoras - config.seguimientoEtapasHoras[0], 0);
        await r.zadd(TRANSFER_KEY, proximoHorarioPermitido(new Date(pasos[0] + deltaHoras * 3600_000)).getTime(), dialogId);
      } else {
        await r.zrem(TRANSFER_KEY, dialogId).catch(() => {});
      }
      return;
    }
    const vencimientoRecordatorio = proximoHorarioPermitido(new Date(ahora + config.seguimientoHoras * 3600_000));
    await r.zadd(DUE_KEY, vencimientoRecordatorio.getTime(), dialogId);
    if (config.seguimientoTransferenciaHoras > 0) {
      // Se calcula relativo al recordatorio YA resuelto (no de nuevo desde "ahora"): si ambos
      // plazos caen de noche, redondear cada uno por separado a "la próxima ventana" los dejaría
      // EMPATADOS en el mismo horario del día siguiente (el recordatorio y la transferencia
      // disparándose juntos) — esto preserva que la transferencia sea siempre estrictamente
      // posterior al recordatorio, dándole al cliente el tiempo real de responder entre ambos.
      const deltaHoras = Math.max(config.seguimientoTransferenciaHoras - config.seguimientoHoras, 0);
      const vencimientoTransferencia = proximoHorarioPermitido(
        new Date(vencimientoRecordatorio.getTime() + deltaHoras * 3600_000),
      );
      await r.zadd(TRANSFER_KEY, vencimientoTransferencia.getTime(), dialogId);
      if (entities && Object.keys(entities).length) {
        await setJson(ENTITIES_KEY(dialogId), entities, ENTITIES_TTL_SEC);
      }
    } else {
      await r.zrem(TRANSFER_KEY, dialogId).catch(() => {});
    }
    if (config.seguimientoSegundoHoras > 0) {
      // Mismo cuidado que con la transferencia: relativo al recordatorio YA resuelto, para que el
      // último mensaje quede siempre estrictamente después del primero aunque ambos plazos caigan
      // de noche y se corran a la misma ventana del día siguiente.
      const deltaHoras = Math.max(config.seguimientoSegundoHoras - config.seguimientoHoras, 0);
      const vencimientoSegundo = proximoHorarioPermitido(
        new Date(vencimientoRecordatorio.getTime() + deltaHoras * 3600_000),
      );
      await r.zadd(SEGUNDO_KEY, vencimientoSegundo.getTime(), dialogId);
    } else {
      await r.zrem(SEGUNDO_KEY, dialogId).catch(() => {});
    }
  } catch (e) {
    log.warn('programarSeguimiento falló', { err: String(e), dialogId });
  }
}

/** Cancela el seguimiento pendiente de un diálogo (un humano tomó la conversación, o el cliente
 *  respondió — ver botEvents.ts, que reprograma en vez de cancelar en ese caso). Cancela las 3
 *  etapas: no tiene sentido recordarle nada ni transferir si ya hay un humano a cargo. */
export async function cancelarSeguimiento(dialogId: string): Promise<void> {
  const r = getRedisClient();
  if (!r) return;
  try {
    await r.zrem(DUE_KEY, dialogId);
    await r.zrem(SEGUNDO_KEY, dialogId);
    await r.zrem(TRANSFER_KEY, dialogId);
    await r.zrem(PASOS_KEY, dialogId);
    await kvDel(PLAN_KEY(dialogId));
  } catch (e) {
    log.warn('cancelarSeguimiento falló', { err: String(e), dialogId });
  }
}

/** `contacto` (solo en el cierre) se pega DESPUÉS del texto del modelo y de las reglas de
 *  respuesta: un número o un correo escrito por el modelo puede salir con un dígito cambiado. */
async function generarMensajeSeguimiento(
  dialogId: string,
  tipo: TipoRecordatorio,
  etapa: number,
  contacto = '',
): Promise<string | null> {
  let t = transcript(await getHistory(dialogId));
  if (t.length < 5 && config.seguimientoInstantanea) t = (await getJson<Snapshot>(SNAPSHOT_KEY(dialogId)))?.transcript ?? '';
  if (t.length < 5) return null;
  const resp = await anthropic.messages.create({
    model: CLASSIFIER,
    max_tokens: 200,
    system: sistemaSeguimiento(tipo, etapa, Boolean(contacto)),
    messages: [{ role: 'user', content: `Conversación:\n${t}\n\nEscribe el mensaje de seguimiento.` }],
  });
  recordTokens((resp as any).usage);
  let texto: string = (resp.content as any[]).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (texto && marca.guardRespuesta) {
    // Las mismas reglas que una respuesta normal: sin markdown, sin fee, sin enlaces no verificados y
    // sin repetir lo que ya se dijo.
    const previas = t.split('\n').filter((l) => l.startsWith('Bot: ')).map((l) => l.slice(5));
    texto = guardarRespuesta(texto, {
      mensajeCliente: '',
      respuestasPrevias: previas,
      urlsPermitidas: URLS_OFICIALES_CARVER,
      maxCaracteres: Number.MAX_SAFE_INTEGER,
    }).texto;
  }
  if (!texto) return null;
  return contacto ? `${texto} ${contacto}` : texto;
}

/** Motivo por el que un recordatorio vencido NO debe enviarse, o null si se puede enviar. Cada uno
 *  queda auditado: antes estos casos se descartaban sin dejar rastro y no había forma de saber si la
 *  secuencia se cumplía. */
async function motivoParaNoEnviar(dialogId: string, auth?: Auth): Promise<string | null> {
  // Modo prueba primero: si hay lista blanca, el bot no le escribe a nadie fuera de ella, ni
  // siquiera para retomar una conversación que ya venía atendiendo. Este camino no pasa por el
  // manejador de mensajes, así que el filtro de allá no lo cubre.
  if (listaBlancaActiva() && auth) {
    const chatId = /^chat(\d+)$/.exec(dialogId)?.[1];
    if (!(await puedeResponder(chatId, auth))) return 'modo_prueba';
  }
  const sess = await getSession(dialogId);
  if (sess.humanTookOver) return 'humano_a_cargo';
  // Respeta la baja ("no me escriban más"): si el contacto de este chat pidió que no le escriban, no
  // se le manda el recordatorio. La baja se registra por contacto (ver crm/exclusion.ts) al detectar
  // la frase en el mensaje; aquí se consulta por el contacto que quedó en las entidades del diálogo.
  // (La derivación por silencio —barrerTransferenciasVencidas— es otra vía y se trata aparte.)
  const ents = await getJson<CrmEntities>(ENTITIES_KEY(dialogId));
  if (ents?.contact && (await estaExcluido({ contactId: ents.contact }))) return 'excluido';
  const snap = await getJson<Snapshot>(SNAPSHOT_KEY(dialogId));
  if (await traspasoVigente(dialogId, snap?.sesion ?? null)) return 'traspaso_a_persona';
  if (snap && Date.now() - snap.clienteAt > VENTANA_WHATSAPP_MS) return 'fuera_ventana_24h';
  if (config.seguimientoMaxPorDia > 0) {
    const enviados = ((await getJson<number[]>(ENVIADOS_KEY(dialogId))) ?? []).filter((x) => Date.now() - x < 24 * 3600_000);
    if (enviados.length >= config.seguimientoMaxPorDia) return 'tope_diario';
  }
  return null;
}

async function registrarEnvio(dialogId: string, etapa: number): Promise<void> {
  const enviados = ((await getJson<number[]>(ENVIADOS_KEY(dialogId))) ?? []).filter((x) => Date.now() - x < 24 * 3600_000);
  await setJson(ENVIADOS_KEY(dialogId), [...enviados, Date.now()], 24 * 3600);
  await setJson(ULTIMO_KEY(dialogId), { etapa, at: Date.now() }, 3 * 24 * 3600);
}

/** El cliente escribió: si lo último que recibió fue un recordatorio, ese recordatorio fue RESPONDIDO.
 *  Separa "enviado" de "contacto efectivo", que es lo que importa medir. */
export async function registrarRespuestaASeguimiento(dialogId: string): Promise<void> {
  try {
    const u = await getJson<{ etapa: number; at: number }>(ULTIMO_KEY(dialogId));
    if (!u) return;
    await kvDel(ULTIMO_KEY(dialogId));
    inc('seguimiento_respondido');
    await audit({
      type: 'seguimiento_respondido',
      dialogId,
      detail: { etapa: u.etapa, horasDesdeEnvio: Math.round(((Date.now() - u.at) / 3600_000) * 10) / 10 },
    });
  } catch (e) {
    log.warn('registrarRespuestaASeguimiento falló', { err: String(e), dialogId });
  }
}

type RedisCliente = NonNullable<ReturnType<typeof getRedisClient>>;

/** Agenda el paso siguiente del plan, o lo da por terminado si era el último. No toca un plan que ya
 *  no es el vigente: si el cliente respondió mientras este paso se enviaba, manda la secuencia nueva. */
async function avanzarPlan(r: RedisCliente, dialogId: string, plan: Plan): Promise<void> {
  const vigente = await getJson<Plan>(PLAN_KEY(dialogId));
  if (!vigente || vigente.id !== plan.id) return;
  const siguiente = plan.siguiente + 1;
  if (siguiente >= plan.pasos.length) {
    await kvDel(PLAN_KEY(dialogId));
    return;
  }
  await setJson(PLAN_KEY(dialogId), { ...plan, siguiente } satisfies Plan, PLAN_TTL_SEC);
  // Si el barrido se atrasó, el paso siguiente no sale pegado a este.
  await r.zadd(PASOS_KEY, Math.max(plan.pasos[siguiente], Date.now() + 15 * 60_000), dialogId);
}

async function terminarPlan(dialogId: string, plan: Plan): Promise<void> {
  const vigente = await getJson<Plan>(PLAN_KEY(dialogId));
  if (vigente?.id === plan.id) await kvDel(PLAN_KEY(dialogId));
}

/** Suma el recordatorio a la instantánea de la conversación. La memoria del chat vence a las 6 h y el
 *  paso siguiente puede salir a la mañana siguiente: sin esto se escribiría sin saber qué dijeron los
 *  anteriores, y los repetiría. */
async function sumarAInstantanea(dialogId: string, mensaje: string): Promise<void> {
  const snap = await getJson<Snapshot>(SNAPSHOT_KEY(dialogId));
  if (!snap) return;
  await setJson(SNAPSHOT_KEY(dialogId), { ...snap, transcript: `${snap.transcript}\nBot: ${mensaje}` } satisfies Snapshot, SNAPSHOT_TTL_SEC);
}

/** Recorre los diálogos vencidos de una cola de recordatorios y envía el mensaje (una sola vez cada
 *  uno — ZREM es el reclamo atómico: si hay más de una réplica corriendo el barrido, solo una logra
 *  "borrar y procesar"). En las colas fijas la etapa la da la cola (`etapaFija`); en la secuencia por
 *  etapas, el plan del chat. La etapa decide el tono del mensaje (ver sistemaSeguimiento) y queda en
 *  la auditoría, para poder separar después cuántos respondieron a cada uno. */
async function barrerRecordatorios(key: string, etapaFija?: 1 | 2): Promise<void> {
  const r = getRedisClient();
  if (!r) return;
  let vencidos: string[] = [];
  try {
    vencidos = await r.zrangebyscore(key, '-inf', Date.now());
  } catch (e) {
    log.warn('barrerRecordatorios: zrangebyscore falló', { err: String(e), key });
    return;
  }
  if (!vencidos.length) return;

  const st = await getState();
  const auth = st.auth;
  const botId = st.botId ?? config.botId;
  if (!auth || !botId) return; // sin auth/bot no se puede enviar nada todavía

  for (const dialogId of vencidos) {
    const reclamado = await r.zrem(key, dialogId).catch(() => 0);
    if (!reclamado) continue; // otra réplica ya lo tomó

    let etapa: number = etapaFija ?? 1;
    let plan: Plan | null = null;
    try {
      // Chequeo defensivo: el plazo se calcula ya respetando el horario (ver programarSeguimiento),
      // pero puede llegar acá fuera de ventana si el barrido se atrasó, o si el recordatorio quedó
      // programado ANTES de que cambiara la regla de horario. Se reprograma en vez de enviarlo.
      //
      // Antes esta condición solo miraba la ventana de seguimiento y no el horario de asesores, así
      // que un recordatorio vencido a las 13:00 salía igual, en plena jornada. Este camino NO pasa
      // por el manejador de mensajes, así que la regla de allá no lo cubría: el bot seguía hablando
      // aunque las respuestas estuvieran apagadas. Ahora se consulta la misma función que programa,
      // que ya contempla las dos ventanas.
      const ahora = new Date();
      const permitido = proximoHorarioPermitido(ahora);
      if (permitido.getTime() !== ahora.getTime()) {
        await r.zadd(key, permitido.getTime(), dialogId);
        continue;
      }

      if (!etapaFija) {
        plan = await getJson<Plan>(PLAN_KEY(dialogId));
        if (!plan) continue; // la secuencia se canceló mientras este paso esperaba
        etapa = plan.siguiente + 1;
      }
      const total = plan ? plan.pasos.length : etapa;
      const tipo = tipoDeEtapa(etapa, total);
      const detalleEtapa = plan ? { etapa, de: total } : { etapa };

      const motivo = await motivoParaNoEnviar(dialogId, auth);
      if (motivo) {
        inc(`seguimiento_omitido:${motivo}`);
        await audit({ type: 'seguimiento_omitido', dialogId, detail: { ...detalleEtapa, motivo } });
        // El tope diario frena solo este paso. Lo demás (una persona a cargo, la baja, la ventana de
        // WhatsApp vencida, el modo prueba) vale igual para los que siguen.
        if (plan) await (motivo === 'tope_diario' ? avanzarPlan(r, dialogId, plan) : terminarPlan(dialogId, plan));
        continue;
      }

      inc('seguimiento_ejecutado');
      const contacto = tipo === 'cierre' ? await contactoParaElCierre(dialogId, auth) : '';
      const mensaje = await generarMensajeSeguimiento(dialogId, tipo, etapa, contacto);
      if (!mensaje) {
        inc('seguimiento_omitido:sin_conversacion');
        await audit({ type: 'seguimiento_omitido', dialogId, detail: { ...detalleEtapa, motivo: 'sin_conversacion' } });
        if (plan) await terminarPlan(dialogId, plan);
        continue;
      }

      // "Enviado" acá significa ENTREGADO A BITRIX (imbot.message.add aceptó el mensaje). La entrega
      // en el teléfono la confirma el conector de WhatsApp y no vuelve por esta vía.
      await callBitrix('imbot.message.add', { BOT_ID: botId, DIALOG_ID: dialogId, MESSAGE: mensaje }, auth);
      await registrarEnvio(dialogId, etapa);
      const history = await getHistory(dialogId);
      await setHistory(dialogId, [...history, { role: 'assistant', content: mensaje }]);
      if (plan) await sumarAInstantanea(dialogId, mensaje);
      inc('seguimiento');
      await audit({
        type: 'seguimiento',
        dialogId,
        detail: plan ? { mensaje, ...detalleEtapa, conContacto: Boolean(contacto) } : { mensaje, etapa },
      });
      log.info('seguimiento enviado', { dialogId, etapa });
      if (plan) await avanzarPlan(r, dialogId, plan);
    } catch (e) {
      // Un recordatorio que no se envía es un cliente al que el bot cree haber contactado y no lo
      // hizo. Antes solo quedaba este log y nada en el panel: la auditoría de 'seguimiento' se
      // escribe DESPUÉS del envío, así que los fallos no dejaban ninguna fila (mismo punto ciego que
      // dejó a 3 clientes sin respuesta, ver fix 748885f).
      inc('errors');
      await audit({
        type: 'error',
        dialogId,
        detail: { etapa: `recordatorio_${etapa}`, err: String(e) },
      }).catch(() => {});
      log.warn('barrerRecordatorios: falló para un diálogo', { err: String(e), dialogId, key });
      // Un envío fallido no corta la secuencia: el paso siguiente lo vuelve a intentar.
      if (plan) await avanzarPlan(r, dialogId, plan).catch(() => {});
    }
  }
}

/** Secuencia por etapas (SEGUIMIENTO_ETAPAS_HORAS): el paso que le toca a cada chat. */
export async function barrerPasosVencidos(): Promise<void> {
  await barrerRecordatorios(PASOS_KEY);
}

/** Primer recordatorio (SEGUIMIENTO_HORAS): retoma el hilo de la conversación. */
export async function barrerSeguimientosVencidos(): Promise<void> {
  await barrerRecordatorios(DUE_KEY, 1);
}

/** Último recordatorio (SEGUIMIENTO_SEGUNDO_HORAS): cierra dejando la puerta abierta. */
export async function barrerSegundosRecordatoriosVencidos(): Promise<void> {
  if (config.seguimientoSegundoHoras <= 0) return;
  await barrerRecordatorios(SEGUNDO_KEY, 2);
}

/** Recorre los diálogos cuyo plazo de TRANSFERENCIA venció (el cliente no respondió ni al
 *  recordatorio) y deriva el lead al asesor asignado por turno (Norte/Sur) + crea una tarea de
 *  contacto temprano — ver crm/asignacionAsesores.ts. A propósito NO llama a markHumanTakeover ni a
 *  imopenlines.bot.session.operator: no es una transferencia urgente, el bot sigue respondiendo si
 *  el cliente vuelve a escribir (mismo reclamo atómico por ZREM que barrerSeguimientosVencidos). */
export async function barrerTransferenciasVencidas(): Promise<void> {
  const r = getRedisClient();
  if (!r) return;
  let vencidos: string[] = [];
  try {
    vencidos = await r.zrangebyscore(TRANSFER_KEY, '-inf', Date.now());
  } catch (e) {
    log.warn('barrerTransferenciasVencidas: zrangebyscore falló', { err: String(e) });
    return;
  }
  if (!vencidos.length) return;

  const st = await getState();
  const auth = st.auth;
  if (!auth) return; // sin auth no se puede leer/escribir el deal todavía

  for (const dialogId of vencidos) {
    const reclamado = await r.zrem(TRANSFER_KEY, dialogId).catch(() => 0);
    if (!reclamado) continue; // otra réplica ya lo tomó
    // Apagada (Carver, 03-11-2026): lo que quedó agendado antes de apagarla vence sin derivar.
    if (config.seguimientoTransferenciaHoras <= 0) continue;

    try {
      const sess = await getSession(dialogId);
      if (sess.humanTookOver) continue; // ya hay un humano a cargo por otra vía

      const entities = await getJson<CrmEntities>(ENTITIES_KEY(dialogId));
      if (!entities || !(entities.deal || entities.lead || entities.contact)) continue;

      // El asesor pudo tomar el caso en el CRM mientras esta transferencia esperaba su turno: mueve
      // la etapa, llama, manda un correo. Nada de eso pasa por el chat, así que `humanTookOver`
      // sigue en false y antes se derivaba igual, devolviendo la negociación a "Derivados Bot" sin
      // que el cliente hubiera escrito una palabra.
      if (entities.deal && (await derivacionYaGestionada(entities.deal, auth))) {
        log.info('seguimiento: un asesor ya trabajó esta derivación; no se vuelve a derivar', { dialogId, deal: entities.deal });
        continue;
      }

      // Solo cuenta como "derivado" si REALMENTE asignó (deal real de uno de los 2 programas piloto,
      // no asignado antes) — antes se registraba igual aunque no aplicara (ej. sin deal todavía, o
      // programa fuera del piloto), inflando el conteo sin que pasara nada. Además, antes el audit
      // no dejaba `crmEntity` (top-level, la columna que cruza con el panel), quedaba siempre NULL.
      // Con punto de entrada único, la derivación por silencio también va ahí. Sin esto, en una
      // marca sin programas piloto configurados asignarAsesorPorTurno devolvía false y el caso se
      // descartaba: nadie recibía al cliente que había quedado en silencio.
      const asignado =
        (await derivarAResponsableFijo(entities, auth)) || (await asignarAsesorPorTurno(entities, auth, 'silencio'));
      if (!asignado) continue;
      inc('seguimiento_transferencia');
      const entity = primaryEntity(entities);
      await audit({
        type: 'seguimiento_transferencia',
        dialogId,
        crmEntity: entity ? `${entity.type}#${entity.id}` : undefined,
        detail: { entities },
      });
      if (entities.deal) void vigilarDerivacion(entities.deal, dialogId);
      log.info('seguimiento: derivado al asesor por falta de respuesta', { dialogId, entities });
    } catch (e) {
      // Si falla, el lead queda sin asesor asignado y sin tarea, y nadie se entera: el ZREM de más
      // arriba ya lo sacó de la cola, así que no se reintenta nunca.
      inc('errors');
      await audit({ type: 'error', dialogId, detail: { etapa: 'derivacion_por_silencio', err: String(e) } }).catch(() => {});
      log.warn('barrerTransferenciasVencidas: falló para un diálogo', { err: String(e), dialogId });
    }
  }
}

let intervalo: ReturnType<typeof setInterval> | null = null;

/** Arranca el barrido periódico (cada SEGUIMIENTO_INTERVALO_MIN minutos): los 2 recordatorios y la
 *  transferencia corren en el mismo tick. No-op sin Redis o con la regla desactivada
 *  (SEGUIMIENTO_HORAS=0), y no se vuelve a arrancar si ya está corriendo. */
export function iniciarBarridoSeguimientos(): void {
  // La vigilancia de derivaciones vive en el mismo tick, pero es independiente del seguimiento al
  // cliente: una marca puede querer avisarle al asesor sin perseguir al cliente.
  if (!getRedisClient() || intervalo) return;
  if (config.seguimientoHoras <= 0 && config.derivacionAlertaHoras <= 0) return;
  intervalo = setInterval(() => {
    barrerSeguimientosVencidos().catch((e) => log.warn('barrerSeguimientosVencidos (intervalo) falló', { err: String(e) }));
    barrerPasosVencidos().catch((e) => log.warn('barrerPasosVencidos (intervalo) falló', { err: String(e) }));
    barrerSegundosRecordatoriosVencidos().catch((e) => log.warn('barrerSegundosRecordatoriosVencidos (intervalo) falló', { err: String(e) }));
    barrerTransferenciasVencidas().catch((e) => log.warn('barrerTransferenciasVencidas (intervalo) falló', { err: String(e) }));
    barrerVigilanciaDerivaciones().catch((e) => log.warn('barrerVigilanciaDerivaciones (intervalo) falló', { err: String(e) }));
  }, config.seguimientoIntervaloMin * 60_000);
  intervalo.unref();
  log.info('seguimiento: barrido activo', {
    horas: config.seguimientoHoras,
    etapasHoras: config.seguimientoEtapasHoras,
    segundoHoras: config.seguimientoSegundoHoras,
    transferenciaHoras: config.seguimientoTransferenciaHoras,
    intervaloMin: config.seguimientoIntervaloMin,
    derivacionAlertaHoras: config.derivacionAlertaHoras,
  });
}
