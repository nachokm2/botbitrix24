import { callCrm } from '../bitrix/client';
import { config } from '../config';
import { log } from '../log';
import type { Auth } from '../store';
import { correoInformacionActivo } from './correoActivo';
import type { CrmEntities } from './entities';
import { getJson, setJson, once, kvDel } from '../store/kv';
import { buscarCondicionesCarver, matchProgramaCarver, BECA_CARVER, type ProgramaCarver } from '../core/condicionesCarver';
import { consultarInformacionInstitucional } from '../core/conocimientoComercial';
import { archivoDelBrochure } from '../core/brochureArchivo';
import { REABRE_POR_DEFECTO } from '../core/ajustesProgramas';
import { getIdentidadAsesor } from './directory';
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

export type DatosCorreoInformacion = {
  nombre?: string;
  programa: ProgramaCarver;
  ingreso?: { inicio: string; cierre?: string } | null;
  conBrochure: boolean;
  asesor?: { nombre?: string; whatsapp?: string; email?: string; formulario?: string } | null;
};

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
  | 'adjunto_no_se_pudo_quitar'
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
const MAX_PDF_BYTES = 12 * 1024 * 1024;

const normalizar = (s: string) =>
  (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Sin caracteres fuera del plano básico (emojis): truncan en seco el campo de texto de Bitrix. */
const sinEmojis = (s: string) => (s ?? '').replace(/[\u{10000}-\u{10FFFF}]/gu, '').replace(/\s+/g, ' ').trim();

const usd = (n?: number) => `USD ${(n ?? 0).toLocaleString('es-CL')}`;

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** "2026-11-23" → "lunes 23 de noviembre de 2026". Vacío si la fecha no es válida. */
export function fechaEnPalabras(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? '').trim());
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime()) || d.getUTCMonth() !== Number(m[2]) - 1) return '';
  return `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} de ${MESES[d.getUTCMonth()]} de ${d.getUTCFullYear()}`;
}

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

/** +56912345678 → "+56 9 1234 5678"; los demás quedan igual (como en ai/seguimiento.ts). */
function telefonoLegible(e164: string): string {
  const m = /^\+569(\d{4})(\d{4})$/.exec(e164);
  return m ? `+56 9 ${m[1]} ${m[2]}` : e164;
}

/** El cuerpo del correo, en texto plano. Es PURO: todo lo que dice viene en `d`. */
export function cuerpoCorreoInformacion(d: DatosCorreoInformacion): string {
  const p = d.programa;
  const nombre = sinEmojis(d.nombre ?? '');
  const sinCupos = !p.cotizable && p.motivoNoCotizable === 'cupos completos';
  const partes: string[] = [];

  partes.push(nombre ? `Hola, ${nombre}:` : 'Hola:');
  partes.push(`Tal como conversamos, le envío la información de la ${p.nombre}.`);

  if (sinCupos) {
    partes.push(
      `Este programa tiene los cupos completos y la matrícula reabre en ${p.reabre || REABRE_POR_DEFECTO}. Le dejo el valor para que pueda planificarlo con tiempo.`,
    );
  }

  const valor: string[] = ['VALOR DEL PROGRAMA'];
  if (p.arancelLista && p.arancelConBeca && p.becaPct) {
    valor.push(`Arancel: ${usd(p.arancelLista)}. Con la ${BECA_CARVER} (${p.becaPct} %), queda en ${usd(p.arancelConBeca)}.`);
  } else if (p.arancelLista) {
    valor.push(`Arancel: ${usd(p.arancelLista)}.`);
  }
  const formas: string[] = [];
  if (p.mensualidades) {
    const regular = p.matriculaRegular && p.matricula !== undefined && p.matriculaRegular > p.matricula ? ` (valor regular: ${usd(p.matriculaRegular)})` : '';
    formas.push(
      `- Mensualidades: ${p.mensualidades.n} cuotas de ${usd(p.mensualidades.monto)}${p.matricula ? `, más una matrícula de ${usd(p.matricula)}${regular}` : ''}.`,
    );
  }
  if (p.semestral) {
    formas.push(`- Semestral: ${p.semestral.n} pagos de ${usd(p.semestral.monto)} (${usd(p.semestral.n * p.semestral.monto)} en total), sin matrícula.`);
  }
  if (p.contado) {
    formas.push(
      p.contado.anios && p.contado.anios > 1 && p.contado.porAnio
        ? `- Contado: ${usd(p.contado.porAnio)} al año durante ${p.contado.anios} años (${usd(p.contado.total)} en total), sin matrícula.`
        : `- Contado: un pago de ${usd(p.contado.total)}, sin matrícula.`,
    );
  }
  if (formas.length) {
    valor.push('', 'Formas de pago:', ...formas);
    if (p.semestral || p.contado) valor.push('', 'El pago semestral y el contado ya incluyen la beca y un descuento adicional.');
  }
  valor.push('Los valores están en dólares estadounidenses (USD).');
  partes.push(valor.join('\n'));

  if (!sinCupos && d.ingreso?.inicio) {
    const inicio = fechaEnPalabras(d.ingreso.inicio);
    const cierre = d.ingreso.cierre ? fechaEnPalabras(d.ingreso.cierre) : '';
    if (inicio) {
      partes.push(['PRÓXIMO INGRESO', `Inicio de clases: ${inicio}.`, ...(cierre ? [`Cierre de postulación: ${cierre}.`] : [])].join('\n'));
    }
  }

  if (d.conBrochure) partes.push('Le adjunto el brochure del programa.');

  const a = d.asesor ?? null;
  const contacto: string[] = [];
  if (a?.whatsapp) contacto.push(`WhatsApp: ${telefonoLegible(a.whatsapp)}`);
  if (a?.email) contacto.push(`Correo: ${a.email}`);
  if (a?.formulario) contacto.push(`Formulario de postulación: ${a.formulario}`);
  partes.push(
    [
      a?.nombre
        ? 'Cualquier duda, puede responder este correo o escribirme por WhatsApp, por el mismo chat en el que conversamos.'
        : 'Cualquier duda, puede responder este correo o escribirnos por WhatsApp, por el mismo chat en el que conversamos.',
      ...contacto,
    ].join('\n'),
  );

  partes.push(['Saludos cordiales,', ...(a?.nombre ? [sinEmojis(a.nombre)] : []), 'Carver University'].join('\n'));
  return partes.join('\n\n');
}

/** Fallos en los que nadie más va a mandar el correo si no se le avisa a una persona del equipo. Los
 *  demás se resuelven en la conversación (pedir el correo, precisar el programa). */
export function requiereAviso(motivo: MotivoFallo): boolean {
  return ['sin_negociacion', 'embudo_ajeno', 'varios_correos', 'error_crm', 'fallo_envio', 'adjunto_no_se_pudo_quitar'].includes(motivo);
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
      incluye: ['valor con la beca', 'formas de pago', 'próximo ingreso', ...(r.conBrochure ? ['brochure en PDF'] : [])],
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

async function descargarPdf(url: string): Promise<Buffer | null> {
  try {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return null;
    const largo = Number(r.headers.get('content-length') ?? 0);
    if (largo > MAX_PDF_BYTES) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_PDF_BYTES || buf.subarray(0, 5).toString('latin1') !== '%PDF-') return null;
    return buf;
  } catch (e) {
    log.warn('correoInformacion: no se pudo descargar el brochure', { err: String(e) });
    return null;
  }
}

/** Id del archivo que tiene hoy el campo de adjunto (Bitrix lo devuelve como objeto o lista). */
function archivoDelCampo(valor: unknown): number | null {
  const v: any = Array.isArray(valor) ? valor[0] : valor;
  const id = Number(v?.id ?? v?.ID ?? 0);
  return id > 0 ? id : null;
}

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
    // La plantilla escribe al contacto DE LA NEGOCIACIÓN: ese es el que manda.
    const contactId = Number(deal?.CONTACT_ID ?? 0) || entities?.contact;
    if (!contactId) return { ok: false, motivo: 'sin_correo' };
    contacto = await callCrm<any>('crm.contact.get', { id: contactId }, auth);
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
  const destinatario = correos[0] ?? '';
  if (!correoValido(destinatario)) return { ok: false, motivo: 'sin_correo' };
  // La plantilla escribe al PRIMER correo, y un correo nuevo se agrega al final de la lista: con dos
  // o más, el envío podría ir a uno viejo, o de otra persona si la ficha es compartida. Que lo mande
  // una persona, que ve cuál es el vigente.
  if (correos.length > 1) return { ok: false, motivo: 'varios_correos' };
  // Si la persona acaba de dar un correo y no es el de la ficha, todavía no se guardó (las herramientas
  // del turno corren en paralelo) o es otro: enviar ahora lo mandaría al de la ficha.
  const dado = String(opts.emailDado ?? '').trim().toLowerCase();
  if (dado && correoValido(dado) && dado !== destinatario) return { ok: false, motivo: 'correo_distinto' };

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
    const hoy = new Date().toISOString().slice(0, 10);
    const cal = consultarInformacionInstitucional('calendario_ingresos');
    const ingreso = cal.ok && cal.disponible ? proximoIngreso(cal.contenido as any[], programa.nombre, hoy) : null;

    const [asesor, archivo] = await Promise.all([
      getIdentidadAsesor({ deal: dealId }, auth).catch(() => null),
      config.ufCorreoInfoAdjunto ? archivoDelBrochure(programa.nombre, auth) : Promise.resolve(null),
    ]);
    const pdf = archivo && archivo.ok ? await descargarPdf(archivo.url) : null;

    // El correo del asesor solo si es del dominio oficial: el Gmail personal de la ficha no se da.
    const dominio = config.dominioCorreoOficial ? `@${config.dominioCorreoOficial}` : '';
    const emailAsesor = asesor?.email && (!dominio || asesor.email.toLowerCase().endsWith(dominio)) ? asesor.email : undefined;
    const cuerpo = cuerpoCorreoInformacion({
      nombre: String(contacto?.NAME ?? ''),
      programa,
      ingreso,
      conBrochure: !!pdf,
      asesor: asesor ? { nombre: asesor.nombre, whatsapp: asesor.telefono, email: emailAsesor, formulario: asesor.formulario } : null,
    });

    const fields: Record<string, unknown> = { [config.ufCorreoInfoCuerpo]: cuerpo };
    const archivoViejo = config.ufCorreoInfoAdjunto ? archivoDelCampo(deal?.[config.ufCorreoInfoAdjunto]) : null;
    if (config.ufCorreoInfoAdjunto) {
      if (pdf && archivo && archivo.ok) fields[config.ufCorreoInfoAdjunto] = { fileData: [archivo.nombre, pdf.toString('base64')] };
      // Sin brochure nuevo, el campo no puede quedar con el de un envío anterior: la plantilla lo
      // adjuntaría, y el brochure de otro programa es peor que ninguno.
      else if (archivoViejo) fields[config.ufCorreoInfoAdjunto] = { id: archivoViejo, del: 'Y' };
    }
    await callCrm('crm.deal.update', { id: dealId, fields }, auth);

    if (config.ufCorreoInfoAdjunto && !pdf && archivoViejo) {
      const despues: any = await callCrm('crm.deal.get', { id: dealId }, auth);
      if (archivoDelCampo(despues?.[config.ufCorreoInfoAdjunto])) {
        log.warn('correoInformacion: no se pudo quitar el adjunto anterior; no se envía', { dealId });
        return { ok: false, motivo: 'adjunto_no_se_pudo_quitar', programa: programa.nombre };
      }
    }

    await callCrm(
      'bizproc.workflow.start',
      { TEMPLATE_ID: config.bizprocTemplateCorreoInfo, DOCUMENT_ID: ['crm', 'CCrmDocumentDeal', `DEAL_${dealId}`] },
      auth,
    );
    await setJson(clave, { at: Date.now(), a: destinatario }, ENVIADO_TTL).catch(() => {});
    await setJson(DIA_KEY(dealId, dia), enviadosHoy + 1, 26 * 3600).catch(() => {});
    await setJson(ULTIMO_KEY(dealId), Date.now(), ENVIADO_TTL).catch(() => {});
    log.info('correo con la información del programa enviado', {
      dealId,
      programa: programa.nombre,
      a: enmascararCorreo(destinatario),
      brochure: !!pdf,
      ingreso: ingreso?.inicio ?? null,
      reenvio: !!previo,
    });
    void audit({
      type: 'correo_informacion',
      dialogId: opts.dialogId,
      crmEntity: `deal#${dealId}`,
      detail: { programa: programa.nombre, brochure: !!pdf, reenvio: !!previo },
    }).catch(() => {});
    return { ok: true, enviadoA: destinatario, conBrochure: !!pdf };
  } catch (e) {
    log.warn('correoInformacion: el envío falló', { err: String(e), dealId });
    return { ok: false, motivo: 'fallo_envio', programa: programa.nombre };
  } finally {
    await kvDel(candado).catch(() => {});
  }
}
