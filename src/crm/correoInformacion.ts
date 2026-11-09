import { callCrm } from '../bitrix/client';
import { config } from '../config';
import { log } from '../log';
import type { Auth } from '../store';
import { correoInformacionActivo } from './correoActivo';
import type { CrmEntities } from './entities';
import { getJson, setJson, once, kvDel } from '../store/kv';
import { buscarCondicionesCarver, matchProgramaCarver } from '../core/condicionesCarver';
import { consultarInformacionInstitucional } from '../core/conocimientoComercial';
import { obtenerBrochure } from '../core/brochures';
import { getDetalle } from '../ai/detalles';
import { detalleVigente } from '../core/ajustes';
import { getIdentidadAsesor } from './directory';
import { htmlCorreoInformacion, asuntoCorreoInformacion } from './correoInformacionHtml';
import { audit } from '../obs/audit';

/**
 * La información del programa, al correo de la persona (Carver).
 *
 * El bot decía "le envío el detalle al correo que tenemos registrado" sin poder enviar nada: el envío
 * por correo existía solo en Postgrados. Un interesado en Psicología lo pidió dos veces y no le llegó
 * nada (chat 1583541, 07-11-2026). Ahora el correo sale de verdad, con lo mismo que el bot dice en el
 * chat:
 *  - el valor con la beca y las tres formas de pago, de la planilla validada (core/condicionesCarver.ts);
 *  - el próximo ingreso, del calendario del panel (core/conocimientoComercial.ts);
 *  - el brochure en PDF, el mismo que se manda por WhatsApp (core/brochureArchivo.ts);
 *  - el contacto del asesor a cargo, solo lo que entregó la coordinación (crm/contactoAsesores.ts).
 * Nada lo escribe el modelo: un correo queda por escrito, y una cifra inventada ahí no se corrige con
 * el mensaje siguiente.
 *
 * Cómo sale: el texto y el PDF se escriben en dos campos de la negociación y se lanza una plantilla de
 * Proceso de Negocio de Bitrix que manda el correo desde el buzón de admisión (CrmSendEmailActivity), el
 * mismo mecanismo del correo de Postgrados. El cuerpo va en texto plano porque Bitrix escapa el HTML de
 * los campos al reemplazarlos en la plantilla, y sin emojis porque truncan el campo (ver
 * crm/brochureEmail.ts). La plantilla le manda el correo al PRIMER correo del contacto de la
 * negociación: por eso es ese el que se informa como destinatario.
 */

export type ResultadoCorreo =
  | { ok: true; enviadoA: string; conBrochure: boolean; yaEnviado?: false }
  | { ok: true; yaEnviado: true; enviadoA: string }
  | { ok: false; motivo: MotivoFallo; programa?: string; opciones?: string[] };

export type MotivoFallo =
  | 'desactivado'
  | 'sin_negociacion'
  | 'embudo_ajeno'
  | 'sin_correo'
  | 'varios_correos'
  | 'correo_distinto'
  | 'programa_no_encontrado'
  | 'programa_ambiguo'
  | 'programa_no_disponible'
  | 'en_curso'
  | 'limite_diario'
  | 'error_crm'
  | 'fallo_envio';

const ENVIADO_KEY = (dealId: number, programa: string) => `correo-info:${dealId}:${normalizar(programa)}`;
const ENVIADO_TTL = 30 * 24 * 3600;
const DIA_KEY = (dealId: number, dia: string) => `correo-info:dia:${dealId}:${dia}`;
const ULTIMO_KEY = (dealId: number) => `correo-info:ultimo:${dealId}`;

/** ¿Salió un correo de información para esta negociación en los últimos `segundos`? Lo usa el aviso
 *  de promesas (ai/agentLoop.ts): "se lo envié hace un rato" es cierto si el correo salió. */
export async function correoEnviadoHace(dealId: number | undefined, segundos: number): Promise<boolean> {
  if (!dealId) return false;
  const at = await getJson<number>(ULTIMO_KEY(dealId)).catch(() => null);
  return !!at && Date.now() - at < segundos * 1000;
}
/** Correos por negociación y día, reenvíos incluidos: un bucle del modelo no puede llenarle la bandeja. */
const MAX_POR_DIA = 3;

const normalizar = (s: string) =>
  (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * El próximo ingreso al que la persona todavía puede postular: el de inicio más cercano cuyo cierre de
 * postulación no pasó. Vale un ciclo para "todos" o uno con el nombre del programa. null si no hay,
 * y entonces el correo no habla de fechas: mejor nada que una fecha vencida por escrito.
 */
export function proximoIngreso(
  entradas: Array<Record<string, unknown>>,
  programa: string,
  hoy: string,
): { inicio: string; cierre?: string } | null {
  const p = normalizar(programa);
  const candidatos = entradas
    .filter((e) => {
      const para = normalizar(String(e.programa ?? ''));
      return para === 'todos' || para === 'todas' || (para.length > 3 && (p.includes(para) || para.includes(p)));
    })
    .map((e) => ({ inicio: String(e.inicioClases ?? ''), cierre: String(e.cierrePostulacion ?? '') }))
    .filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.inicio) && e.inicio >= hoy && (!e.cierre || e.cierre >= hoy))
    .sort((a, b) => a.inicio.localeCompare(b.inicio));
  const c = candidatos[0];
  if (!c) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(c.cierre) ? { inicio: c.inicio, cierre: c.cierre } : { inicio: c.inicio };
}

/** Fallos en los que nadie más va a mandar el correo si no se le avisa a una persona del equipo. Los
 *  demás se resuelven en la conversación (pedir el correo, precisar el programa). */
export function requiereAviso(motivo: MotivoFallo): boolean {
  return ['sin_negociacion', 'embudo_ajeno', 'varios_correos', 'error_crm', 'fallo_envio'].includes(motivo);
}

/** "persona@yahoo.com" → "p***@yahoo.com". Es lo único que ve el modelo y lo que va al registro: si
 *  Bitrix enlazó el chat a la ficha de otra persona (pasa con números compartidos), el bot no le
 *  recita a un tercero un correo ajeno (mismo criterio que ai/agentLoop.ts:enmascararEmail). */
export function enmascararCorreo(email: string): string {
  const [local, dominio] = String(email ?? '').split('@');
  return dominio ? `${local.slice(0, 1)}***@${dominio}` : '***';
}

/** Lo que recibe el modelo. `avisado`: si ya quedó la tarea para que una persona lo envíe. */
export function resultadoParaElModelo(r: ResultadoCorreo, avisado = false): Record<string, unknown> {
  const dominio = (e: string) => `@${String(e).split('@')[1] ?? ''}`;
  if (r.ok && r.yaEnviado) {
    return {
      ok: true,
      yaEnviado: true,
      enviadoA: enmascararCorreo(r.enviadoA),
      nota:
        `Ya se la enviaste antes, al correo que termina en ${dominio(r.enviadoA)}. No digas que la vuelves a enviar: ` +
        'recuérdale que la tiene ahí y que revise también spam o promociones. Si dice que no le llegó, vuelve a llamar a esta herramienta y se reenvía.',
    };
  }
  if (r.ok) {
    return {
      ok: true,
      enviadoA: enmascararCorreo(r.enviadoA),
      incluye: ['valor con la beca', 'formas de pago', 'próximo ingreso', ...(r.conBrochure ? ['enlace al brochure'] : [])],
      nota:
        `Listo: el correo salió al que termina en ${dominio(r.enviadoA)}. Díselo en UNA frase («se la acabo de enviar ` +
        `al correo que termina en ${dominio(r.enviadoA)}»), sin escribir la dirección completa, y que si no lo ve revise ` +
        'spam o promociones. No repitas en el chat lo que va en el correo.',
    };
  }
  const base = { ok: false, motivo: r.motivo };
  switch (r.motivo) {
    case 'sin_correo':
      return {
        ...base,
        nota:
          'La ficha no tiene un correo válido. Pídele su correo (o confírmalo si ya lo dio), regístralo con ' +
          'registrar_interes_crm y, cuando esa herramienta responda, vuelve a llamar a esta. No digas que se la enviaste.',
      };
    case 'correo_distinto':
      return {
        ...base,
        nota:
          'El correo que te dio todavía no está guardado en su ficha. Regístralo con registrar_interes_crm y, cuando esa ' +
          'herramienta responda, vuelve a llamar a esta con el mismo correo. No digas que se la enviaste.',
      };
    case 'programa_ambiguo':
      return { ...base, opciones: r.opciones, nota: 'Hay más de un programa con ese nombre: pregúntale cuál le interesa y vuelve a llamarla con el nombre exacto.' };
    case 'programa_no_encontrado':
      return { ...base, nota: 'No encuentro ese programa en la planilla. Confirma el nombre exacto con consultar_programas y vuelve a llamarla. No digas que se la enviaste.' };
    case 'programa_no_disponible':
      return { ...base, nota: 'Ese programa no está disponible para enviarlo por correo. No digas que se lo enviaste: sigue la conversación con lo que sí está disponible.' };
    case 'en_curso':
      return { ...base, nota: 'El correo se está enviando en este mismo momento: dile que en unos minutos le llega a su correo.' };
    case 'limite_diario':
      return { ...base, nota: 'Hoy ya se le enviaron varios correos. No envíes otro: dile que la información está en los que ya recibió y resuelve aquí lo que necesite.' };
    default:
      return {
        ...base,
        nota: avisado
          ? 'El envío automático no funcionó y ya quedó la tarea para que se la envíen por correo. Dile que se la hace llegar al correo, sin decir que ya salió ni dar un plazo, y si la necesita ahora dale aquí lo esencial (el valor y las formas de pago) en mensajes cortos.'
          : 'No se pudo enviar el correo. NO digas que se la enviaste ni que se la enviarás: dale aquí mismo lo que pidió, en mensajes cortos.',
      };
  }
}

/** La persona pide que se lo manden otra vez, o dice que no le llegó. */
export function pideReenvio(texto: string): boolean {
  const t = normalizar(texto ?? '');
  return /\b(reenvi\w*|de nuevo|otra vez|nuevamente|no (me )?(llego|ha llegado|aparece|lo veo|lo encuentro)|no (lo )?(recibi|he recibido))\b/.test(t);
}

const correoValido = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

/**
 * Envía el correo. Nunca lanza. Una vez por programa y negociación, salvo que la persona pida que se
 * lo reenvíen (y como mucho MAX_POR_DIA al día).
 */
export async function enviarInformacionPorCorreo(
  programaPedido: string,
  entities: CrmEntities | undefined,
  auth: Auth,
  opts: { ultimoMensajeCliente?: string; dialogId?: string; emailDado?: string } = {},
): Promise<ResultadoCorreo> {
  if (!correoInformacionActivo()) return { ok: false, motivo: 'desactivado' };
  const dealId = entities?.deal;
  if (!dealId) return { ok: false, motivo: 'sin_negociacion' };

  // El programa, con el mismo criterio que la cotización del chat: lo que no se cotiza no se escribe.
  const cond: any = buscarCondicionesCarver(programaPedido);
  if (!cond.encontrado || cond.general) return { ok: false, motivo: 'programa_no_encontrado' };
  if (cond.ambiguo) return { ok: false, motivo: 'programa_ambiguo', opciones: cond.opciones };
  if (cond.comercializable === false || cond.cotizable === false || cond.gratis) {
    return { ok: false, motivo: 'programa_no_disponible', programa: cond.programa };
  }
  const programa = matchProgramaCarver(cond.programa).find((p) => p.nombre === cond.programa);
  if (!programa) return { ok: false, motivo: 'programa_no_encontrado' };

  let deal: any;
  let contacto: any;
  try {
    deal = await callCrm<any>('crm.deal.get', { id: dealId }, auth);
    if (config.embudosPropios.length && !config.embudosPropios.includes(Number(deal?.CATEGORY_ID ?? -1))) {
      return { ok: false, motivo: 'embudo_ajeno' };
    }
    // El correo va al contacto DE LA NEGOCIACIÓN.
    const contactId = Number(deal?.CONTACT_ID ?? 0) || entities?.contact;
    if (!contactId) return { ok: false, motivo: 'sin_correo' };
    contacto = { ...(await callCrm<any>('crm.contact.get', { id: contactId }, auth)), ID: contactId };
  } catch (e) {
    log.warn('correoInformacion: no se pudo leer la negociación o el contacto', { err: String(e), dealId });
    return { ok: false, motivo: 'error_crm' };
  }
  const correos = [
    ...new Set(
      (Array.isArray(contacto?.EMAIL) ? contacto.EMAIL : [])
        .map((e: any) => String(e?.VALUE ?? '').trim().toLowerCase())
        .filter(Boolean),
    ),
  ] as string[];
  // Si la persona acaba de dar o confirmar un correo, va a ESE. Si todavía no está en la ficha (las
  // herramientas del turno corren en paralelo), primero se registra.
  const dado = String(opts.emailDado ?? '').trim().toLowerCase();
  let destinatario = '';
  if (dado && correoValido(dado)) {
    if (!correos.includes(dado)) return { ok: false, motivo: 'correo_distinto' };
    destinatario = dado;
  } else {
    // Con dos o más correos y sin uno confirmado en la conversación, no se elige al azar: puede ser
    // uno viejo, o de otra persona si la ficha es compartida. Que lo mande una persona.
    if (correos.length > 1) return { ok: false, motivo: 'varios_correos' };
    destinatario = correos[0] ?? '';
  }
  if (!correoValido(destinatario)) return { ok: false, motivo: 'sin_correo' };

  const clave = ENVIADO_KEY(dealId, programa.nombre);
  const previo = await getJson<{ at: number; a: string }>(clave).catch(() => null);
  if (previo && previo.a === destinatario && !pideReenvio(opts.ultimoMensajeCliente ?? '')) {
    return { ok: true, yaEnviado: true, enviadoA: destinatario };
  }
  const dia = new Date().toISOString().slice(0, 10);
  const enviadosHoy = (await getJson<number>(DIA_KEY(dealId, dia)).catch(() => 0)) ?? 0;
  if (enviadosHoy >= MAX_POR_DIA) return { ok: false, motivo: 'limite_diario' };
  // Dos turnos en paralelo (ráfagas de mensajes) no mandan dos correos.
  const candado = `correo-info:enviando:${dealId}`;
  if (!(await once(candado, 120))) return { ok: false, motivo: 'en_curso' };

  try {
    const hoy = hoyEnChile();
    const cal = consultarInformacionInstitucional('calendario_ingresos');
    const ingreso = cal.ok && cal.disponible ? proximoIngreso(cal.contenido as any[], programa.nombre, hoy) : null;
    const duracion = detalleVigente(getDetalle({ nombre: programa.nombre }))?.duracion;

    const [asesor, brochure] = await Promise.all([
      getIdentidadAsesor({ deal: dealId }, auth).catch(() => null),
      obtenerBrochure({ programa: programa.nombre }).catch(() => null),
    ]);
    const brochureUrl = brochure && brochure.ok ? brochure.url : undefined;

    // El correo del asesor solo si es del dominio oficial: el Gmail personal de la ficha no se da.
    const dominio = config.dominioCorreoOficial ? `@${config.dominioCorreoOficial}` : '';
    const emailAsesor = asesor?.email && (!dominio || asesor.email.toLowerCase().endsWith(dominio)) ? asesor.email : undefined;
    const nombre = String(contacto?.NAME ?? '');
    const html = htmlCorreoInformacion({
      nombre,
      programa,
      duracion,
      ingreso,
      brochureUrl,
      asesor: asesor ? { nombre: asesor.nombre, whatsapp: asesor.telefono, email: emailAsesor, formulario: asesor.formulario } : null,
      hoy,
    });

    const responsable = Number(deal?.ASSIGNED_BY_ID ?? 0);
    const id = await callCrm<number>(
      'crm.activity.add',
      {
        fields: {
          OWNER_TYPE_ID: 2,
          OWNER_ID: dealId,
          TYPE_ID: 4,
          DIRECTION: 2,
          SUBJECT: asuntoCorreoInformacion(nombre, programa.nombre),
          DESCRIPTION: html,
          DESCRIPTION_TYPE: 3,
          COMPLETED: 'Y',
          ...(responsable > 0 ? { RESPONSIBLE_ID: responsable } : {}),
          COMMUNICATIONS: [{ VALUE: destinatario, ENTITY_ID: Number(contacto.ID), ENTITY_TYPE_ID: 3, TYPE: 'EMAIL' }],
          SETTINGS: { MESSAGE_FROM: config.correoInfoRemitente },
        },
      },
      auth,
    );
    // Que Bitrix haya creado la actividad no basta: se confirma que el correo salió.
    const creada: any = id ? await callCrm('crm.activity.get', { id }, auth).catch(() => null) : null;
    if (!creada?.SETTINGS?.IS_MESSAGE_SENT) {
      log.warn('correoInformacion: Bitrix no confirmó el envío', { dealId, actividad: id ?? null });
      return { ok: false, motivo: 'fallo_envio', programa: programa.nombre };
    }

    await setJson(clave, { at: Date.now(), a: destinatario }, ENVIADO_TTL).catch(() => {});
    await setJson(DIA_KEY(dealId, dia), enviadosHoy + 1, 26 * 3600).catch(() => {});
    await setJson(ULTIMO_KEY(dealId), Date.now(), ENVIADO_TTL).catch(() => {});
    log.info('correo con la información del programa enviado', {
      dealId,
      actividad: id,
      programa: programa.nombre,
      a: enmascararCorreo(destinatario),
      brochure: !!brochureUrl,
      ingreso: ingreso?.inicio ?? null,
      reenvio: !!previo,
    });
    void audit({
      type: 'correo_informacion',
      dialogId: opts.dialogId,
      crmEntity: `deal#${dealId}`,
      detail: { programa: programa.nombre, brochure: !!brochureUrl, reenvio: !!previo, actividad: id },
    }).catch(() => {});
    return { ok: true, enviadoA: destinatario, conBrochure: !!brochureUrl };
  } catch (e) {
    log.warn('correoInformacion: el envío falló', { err: String(e), dealId });
    return { ok: false, motivo: 'fallo_envio', programa: programa.nombre };
  } finally {
    await kvDel(candado).catch(() => {});
  }
}

/** Hoy en Chile (YYYY-MM-DD): las fechas de postulación son de allá. */
function hoyEnChile(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
}
