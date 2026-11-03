import { consultarProgramas, detallePrograma } from '../core/catalogTool';
import { buscarCondiciones } from '../core/condicionesComerciales';
import { conAvisoDeVigencia } from '../core/vigencia';
import type { AgentContext } from '../core/channel';
import { actualizarDatosCliente, obtenerContextoLlamada } from '../crm/crmWrite';
import { getDealAsesores } from '../crm/directory';
import { asignarAsesorPorTurno, derivarAResponsableFijo } from '../crm/asignacionAsesores';
import { destinoDelChat } from '../crm/entregaChat';
import { vigilarDerivacion } from '../crm/vigilanciaDerivaciones';
import { generarBriefing } from './briefing';
import { iniciarLlamadaSaliente } from '../voice/outbound';
import { markHumanTakeover, getSession, saveSession, marcarTraspaso } from '../session';
import { cancelarSeguimiento } from './seguimiento';
import { callBitrix, callCrm } from '../bitrix/client';
import { once, getJson, setJson } from '../store/kv';
import { marca } from '../marca';
import { preguntaPorCostosAdicionales } from '../core/guardRespuesta';
import { obtenerBrochure } from '../core/brochures';
import { consultarInformacionInstitucional, INSTRUCCION_SIN_DATO } from '../core/conocimientoComercial';
import { consultarEstadoEstudiante, crearTareaAdvisor } from '../crm/estudiantes';
import { enlaceDePago } from '../core/mediosPago';
import { registrarDatosMatricula, moverAPendienteDeFirma } from '../crm/matricula';
import { enviarBrochurePorWhatsApp } from '../core/brochureArchivo';
import { registrarDocumentoAcademico, nivelDelPrograma, DOCUMENTO_DE } from '../crm/documentoAcademico';
import { getDealInfo } from '../crm/directory';
import { avisarAlResponsable } from '../crm/avisoAsesor';
import { motivoParaRetener, cuandoVuelveElEquipo } from '../core/retenerChat';
import { audit } from '../obs/audit';
import { config } from '../config';
import { log } from '../log';

/**
 * Sigue el programa de interés REAL de la conversación y lo escribe en el CRM.
 *
 * El prompt ya pedía mantener el campo al día llamando a registrar_interes_crm con el programa
 * nuevo, pero el modelo no siempre lo hacía: la ficha quedaba con el primer programa que se nombró
 * aunque la conversación entera girara sobre otro, y el asesor recibía un caso mal etiquetado.
 * Acá no depende de que lo recuerde: si pidió el detalle o el precio de un programa concreto, ESE
 * es el programa de interés. Solo escribe cuando cambia, así que una persona que compara dos
 * programas no genera una reescritura por turno.
 */
async function seguirProgramaDeInteres(resultado: any, ctx: AgentContext): Promise<void> {
  const programa = typeof resultado?.programa === 'string'
    ? resultado.programa
    : typeof resultado?.detalle?.nombre === 'string'
      ? resultado.detalle.nombre
      : typeof resultado?.nombre === 'string'
        ? resultado.nombre
        : null;
  // `ambiguo` significa que la herramienta pide precisar: todavía no hay un programa elegido. Y un
  // programa fuera de la oferta autorizada (un NOOC) no se registra como interés comercial.
  if (!programa || resultado?.ambiguo || resultado?.ok === false || resultado?.comercializable === false) return;
  // Solo actualiza una ficha que YA existe: consultar el catálogo no debe crear un lead. La ficha la
  // crea la captura de datos (registrar_interes_crm), que es cuando la persona entrega algo suyo.
  const e = ctx.crmEntities;
  if (!e || !(e.deal || e.lead || e.contact)) return;
  try {
    const sess = await getSession(ctx.conversationId);
    if (sess.programaCrm === programa) return;
    sess.programaCrm = programa;
    await saveSession(ctx.conversationId, sess);
    await actualizarDatosCliente(ctx.crmEntities, ctx.chatId, { programa_interes: programa }, ctx.auth, { soloConsulta: true });
    log.info('programa de interés actualizado desde la conversación', { dialogId: ctx.conversationId, programa });
  } catch (e) {
    log.warn('seguirProgramaDeInteres falló', { err: String(e), programa });
  }
}

const ESTUDIANTE_KEY = (dialogId: string) => `estudiante:${dialogId}`;
/** Marca que la foto de la cedula de ESTA conversacion ya se guardo. La ficha de matricula no se
 *  da por completa sin ella, y releer el campo archivo del deal en cada turno es caro. */
const CEDULA_KEY = (dialogId: string) => `cedula:${dialogId}`;
/** Igual que la cedula, para que la ficha de matricula sepa que ya llego. */
const ACADEMICO_KEY = (dialogId: string) => `academico:${dialogId}`;
// Canal oficial de Carver para consultas administrativas, tomado del conocimiento institucional ya
// validado en el prompt (core/promptObjeciones.ts).
const CONTACTO_GENERAL = 'admission@carver.university / +1 (321) 300-1034';

// Carver manda el brochure por iniciativa propia (OFERTA_ENLACES en ai/prompt.ts), así que el modelo
// lo pediría cada vez que la conversación vuelve al programa. Va una vez por programa y conversación,
// salvo que la persona pida que se lo manden de nuevo.
const BROCHURE_ENVIADO_KEY = (dialogId: string, programa: string) => `brochure-enviado:${dialogId}:${programa}`;
const BROCHURE_ENVIADO_TTL = 30 * 24 * 3600;

/** La persona pide (de nuevo) el brochure, o dice que no le llegó. "Gracias por el brochure" no cuenta. */
export function pideElBrochure(texto: string): boolean {
  const t = (texto ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (/\b(reenvi\w*|de nuevo|otra vez|nuevamente|no (me )?(llego|abre|abrio|carga)|no (lo )?(veo|encuentro))\b/.test(t)) return true;
  return /\b(brochure|folleto|pdf)\b/.test(t) && /\b(envi\w*|mand\w*|pas\w*|compart\w*|tien\w*|quier\w*|quisiera|pued\w*|podria)\b/.test(t);
}

/** Lo que recibe el modelo cuando el brochure se entrega como ENLACE (o no se puede entregar). Lo usa
 *  también el chat simulado del panel (ai/simulador.ts), para que la prueba vea lo mismo. */
export function brochureComoEnlace(r: Awaited<ReturnType<typeof obtenerBrochure>>) {
  if (r.ok) {
    return {
      ok: true,
      programa: r.programa,
      url: r.url,
      formato: r.formato,
      entregadoComo: 'enlace',
      nota:
        r.formato === 'pdf'
          ? 'Brochure oficial en PDF, verificado ahora. Compártelo tal cual, en una línea aparte.'
          : 'Brochure oficial en PDF, verificado ahora: el enlace abre el documento en el navegador, donde se puede ver y descargar. Compártelo tal cual, en una línea aparte, y no prometas que llega como archivo adjunto.',
    };
  }
  return {
    ok: false,
    programa: r.programa,
    motivo: r.motivo,
    nota:
      r.motivo === 'programa_no_comercializable'
        ? 'Ese programa no forma parte de la oferta de este canal: no hay brochure que entregar. Ofrece las licenciaturas y maestrías relacionadas.'
        : 'No pude verificar el brochure en este momento. NO compartas ningún enlace (ni el de la ficha). Dile que se lo harás llegar por este medio, y registra la solicitud con registrar_interes_crm (comentario: "Solicitó el brochure de <programa>").',
  };
}

/** Lo que recibe el modelo al derivar en una marca donde el bot habla COMO el asesor (Carver). */
export const RESULTADO_ESCALADO_COMO_ASESOR = {
  ok: true,
  escalado: true,
  asesor: null,
  mensaje:
    'Conversación derivada para seguimiento. Tú eres su asesor: confírmale en primera persona que quedas a cargo ' +
    '("quedo pendiente", "le hago seguimiento"). No nombres a otra persona ni hables de ti en tercera persona.',
} as const;

export async function executeTool(name: string, input: any, ctx: AgentContext): Promise<any> {
  const catalog = ctx.profile.catalog;
  try {
    switch (name) {
      case 'consultar_programas':
        return consultarProgramas(input, catalog.consultar);

      case 'detalle_programa': {
        const r = detallePrograma(input, catalog.detalle);
        void seguirProgramaDeInteres(r, ctx);
        return r;
      }

      case 'consultar_condiciones_comerciales': {
        // Los costos fuera del arancel (titulación, inscripción, retiro) solo viajan si el cliente los
        // preguntó explícitamente: lo decide el código con su mensaje, no el modelo (hallazgo 5).
        const r = buscarCondiciones(input?.programa, input?.sede, {
          incluirCostosAdicionales: preguntaPorCostosAdicionales(ctx.ultimoMensajeCliente ?? ''),
        });
        void seguirProgramaDeInteres(r, ctx);
        // Si la planilla ya caducó, el precio sale igual pero marcado como referencia (ver
        // core/vigencia.ts): el bot no puede saber que cambió, pero sí puede dejar de afirmarlo.
        return conAvisoDeVigencia(r as Record<string, any>);
      }

      case 'registrar_interes_crm': {
        const r = await actualizarDatosCliente(ctx.crmEntities, ctx.chatId, input ?? {}, ctx.auth);
        if (!r.ok) {
          // Bitrix no respondió: el bot no puede decir que el dato "quedó registrado" (escenario de
          // la auditoría de Carver con el CRM caído). La regla además se impone en el guardián.
          return marca.guardRespuesta
            ? {
                ok: false,
                error: r.error,
                mensaje:
                  'No se pudo guardar en el CRM en este momento. NO digas que quedó registrado ni que lo contactarán: sigue atendiendo con normalidad y no vuelvas a pedir el dato que ya te dio.',
              }
            : { ok: false, error: r.error };
        }
        log.info('tool registrar_interes_crm', { actualizado: r.actualizado });
        return { ok: true, actualizado: r.actualizado };
      }

      case 'registrar_documento_identidad': {
        if (!ctx.pendingImage) {
          return {
            ok: false,
            error: 'SIN_IMAGEN',
            mensaje: 'No hay ninguna imagen nueva en este turno; solo puedes usar esto justo después de que el cliente envíe la foto.',
          };
        }
        const dealId = ctx.crmEntities?.deal;
        if (!dealId || !config.ufCedula) {
          return {
            ok: false,
            error: 'SIN_DEAL',
            mensaje: 'Todavía no tengo su ficha lista para adjuntar el documento; sigue capturando sus datos y ofrece que lo reenvíe apenas la tengamos.',
          };
        }
        const ext = ctx.pendingImage.mediaType.includes('png') ? 'png' : 'jpg';
        await callCrm(
          'crm.deal.update',
          { id: dealId, fields: { [config.ufCedula]: { fileData: [`cedula-deal-${dealId}.${ext}`, ctx.pendingImage.base64] } } },
          ctx.auth,
        );
        await setJson(CEDULA_KEY(ctx.conversationId), { at: Date.now() }, 30 * 24 * 3600);
        log.info('tool registrar_documento_identidad: cédula subida al deal', { dealId });
        return {
          ok: true,
          mensaje: marca.matriculaEnChat
            ? 'Confirma cálidamente que recibiste su documento y sigue con los antecedentes que falten: vuelve a usar registrar_datos_matricula para saber cuáles son.'
            : 'Confirma cálidamente al cliente que recibiste su documento correctamente y continúa el proceso.',
        };
      }

      case 'solicitar_llamada': {
        const raw = String(input?.telefono ?? '').replace(/[\s()\-.]/g, '');
        // Normaliza a E.164 chileno y valida (+569XXXXXXXX). Evita marcar a números arbitrarios/premium.
        const telefono = raw.startsWith('+') ? raw : raw.startsWith('56') ? `+${raw}` : `+56${raw.replace(/^0+/, '')}`;
        if (!/^\+569\d{8}$/.test(telefono)) {
          return {
            ok: false,
            error: 'TELEFONO_INVALIDO',
            mensaje: 'Número inválido; confirma un móvil chileno (+56 9 ...) u ofrece derivar a un asesor.',
          };
        }
        // Rate-limit: máximo una llamada solicitada por diálogo/hora (evita abuso y coste).
        if (!(await once(`call:${ctx.conversationId}`, 3600))) {
          return {
            ok: false,
            error: 'LIMITE_LLAMADAS',
            mensaje: 'Ya se solicitó una llamada hace poco; ofrece que un asesor lo contacte.',
          };
        }
        // Guarda/actualiza el teléfono en el CRM antes de llamar (best-effort, no bloquea).
        void actualizarDatosCliente(ctx.crmEntities, ctx.chatId, { telefono }, ctx.auth).catch(() => {});
        // Nombre + programa de interés ya capturados por chat: la llamada abre YA con ese contexto.
        const contexto = await obtenerContextoLlamada(ctx.crmEntities, ctx.auth).catch(() => ({}));
        // Diálogo de origen: al terminar la llamada, el bot retoma esta MISMA conversación por WhatsApp.
        const origen = ctx.botId ? { dialogId: ctx.conversationId, botId: ctx.botId } : undefined;
        // Ancla la MISMA ficha del CRM (deal/contacto/lead) en la llamada, para que el agente de voz
        // resuelva la misma entidad y lea la conversación previa → continuidad: NO re-pide los datos.
        const idMeta: Record<string, number> = {};
        if (ctx.crmEntities?.deal) idMeta.dealId = ctx.crmEntities.deal;
        if (ctx.crmEntities?.contact) idMeta.contactId = ctx.crmEntities.contact;
        if (ctx.crmEntities?.lead) idMeta.leadId = ctx.crmEntities.lead;
        const r = await iniciarLlamadaSaliente(
          telefono,
          contexto,
          origen,
          Object.keys(idMeta).length ? { metadata: idMeta } : undefined,
        );
        if (!r.ok) {
          log.warn('tool solicitar_llamada falló', { err: r.error });
          return {
            ok: false,
            error: r.error,
            mensaje: 'No se pudo iniciar la llamada ahora. Ofrece que un asesor lo contacte en su lugar.',
          };
        }
        log.info('tool solicitar_llamada', { telefono, callId: r.callId });
        return {
          ok: true,
          llamando: true,
          mensaje: 'Llamada iniciada. Dile al cliente que recibirá la llamada en unos momentos.',
        };
      }

      case 'obtener_brochure': {
        const r = await obtenerBrochure({ programa: input?.programa });
        await audit({
          type: 'brochure',
          dialogId: ctx.conversationId,
          detail: r.ok ? { programa: r.programa, formato: r.formato } : { programa: r.programa, motivo: r.motivo },
        }).catch(() => {});
        const enviadoKey = BROCHURE_ENVIADO_KEY(ctx.conversationId, r.programa ?? '');
        if (r.ok && marca.brochureVerificado) {
          if ((await getJson<number>(enviadoKey)) && !pideElBrochure(ctx.ultimoMensajeCliente ?? '')) {
            return {
              ok: true,
              programa: r.programa,
              yaEnviado: true,
              nota:
                'El brochure de este programa ya se le envió antes en esta conversación. NO lo vuelvas a ' +
                'enviar ni pegues enlaces; sigue con lo que la persona preguntó.',
            };
          }
          await setJson(enviadoKey, Date.now(), BROCHURE_ENVIADO_TTL);
        }
        if (r.ok) {
          // Se intenta mandar el PDF como ARCHIVO por WhatsApp. Un enlace obliga a salir a un
          // navegador y mucha gente no lo hace; el archivo le queda en el telefono. Si no se puede
          // —no hay PDF de ese programa, no hay telefono, ChatApp falla— se entrega el enlace, que
          // es el comportamiento de siempre.
          const envio = await enviarBrochurePorWhatsApp(r.programa, ctx.crmEntities ?? {}, ctx.auth);
          await audit({
            type: 'brochure',
            dialogId: ctx.conversationId,
            detail: { programa: r.programa, comoArchivo: envio.enviado, motivo: envio.enviado ? undefined : envio.motivo },
          }).catch(() => {});
          if (envio.enviado) {
            return {
              ok: true,
              programa: r.programa,
              entregadoComo: 'archivo_pdf',
              nota:
                'El PDF ya se le envió a su WhatsApp, en este mismo momento. NO pegues ningún enlace: ' +
                'dile en una frase breve que se lo acabas de enviar y pregúntale si tiene dudas del programa.',
            };
          }
        }
        return brochureComoEnlace(r);
      }

      case 'consultar_estado_estudiante': {
        const r = await consultarEstadoEstudiante(ctx.crmEntities ?? {}, ctx.auth, input?.programa);
        if (r.ok && r.matriculado) {
          // Se recuerda para que una derivación posterior vaya a SU Advisor y no al flujo comercial.
          await setJson(ESTUDIANTE_KEY(ctx.conversationId), { dealId: r.dealId, advisorId: r.advisor?.id ?? null }, 7 * 24 * 3600);
          return {
            ...r,
            contactoGeneral: CONTACTO_GENERAL,
            nota: r.advisor
              ? `Es estudiante. NO le ofrezcas programas ni le pidas datos de contacto. Dale los datos de contacto de su Advisor (${r.advisor.nombre}, ${r.advisor.email}${
                  r.advisor.telefono ? `, WhatsApp ${r.advisor.telefono}` : ''
                }) para su inconveniente y ofrécele avisarle tú: si acepta, usa escalar_a_humano con tipo "soporte_estudiante". Entrega SOLO los datos que aparecen acá; si no hay teléfono, no lo menciones ni lo inventes.`
              : r.motivoSinAdvisor === 'sin_programa'
                ? 'Es estudiante, pero su ficha no dice qué programa cursa y la Advisor depende de eso. NO le ofrezcas programas ni le pidas datos de contacto: pregúntale en qué programa está matriculado y, cuando te responda, vuelve a usar consultar_estado_estudiante.'
                : 'Es estudiante, pero no se pudo verificar quién es su Advisor: NO inventes un nombre, un correo ni un teléfono. Indícale el canal oficial (contactoGeneral) y deriva con escalar_a_humano con tipo "soporte_estudiante".',
          };
        }
        if (r.ok) {
          return {
            ...r,
            contactoGeneral: CONTACTO_GENERAL,
            nota: 'No figura como estudiante matriculado en el CRM. No lo contradigas: si insiste en que es estudiante, indícale el canal oficial (contactoGeneral) y ofrece derivar.',
          };
        }
        return {
          ...r,
          contactoGeneral: CONTACTO_GENERAL,
          nota: 'No se pudo consultar el CRM ahora. No afirmes nada sobre su matrícula: indícale el canal oficial (contactoGeneral) y ofrece derivar.',
        };
      }

      case 'consultar_informacion_institucional': {
        const r = consultarInformacionInstitucional(String(input?.tema ?? ''));
        await audit({
          type: 'conocimiento',
          dialogId: ctx.conversationId,
          detail: { tema: input?.tema, disponible: r.ok ? r.disponible : false, motivo: r.ok && !r.disponible ? r.motivo : undefined },
        }).catch(() => {});
        return r.ok ? r : { ...r, instruccion: INSTRUCCION_SIN_DATO };
      }

      case 'obtener_enlace_de_pago': {
        const r = enlaceDePago(String(input?.programa ?? ''), String(input?.concepto ?? '') as any);
        await audit({
          type: 'conocimiento',
          dialogId: ctx.conversationId,
          detail: {
            tema: 'enlace_de_pago',
            programa: input?.programa,
            concepto: input?.concepto,
            medio: r.ok ? r.medio : undefined,
            montoUsd: r.ok ? r.montoUsd : undefined,
            motivo: r.ok ? undefined : r.motivo,
          },
        }).catch(() => {});
        // Quien recibe un enlace de pago está a un paso de matricularse: su asesor tiene que saberlo
        // hoy, no cuando revise el CRM. No bloquea la respuesta al cliente.
        if (r.ok && marca.avisaPagoAlAsesor) {
          void avisarAlResponsable(
            {
              tipo: 'pago',
              dialogId: ctx.conversationId,
              dealId: ctx.crmEntities?.deal,
              chatId: ctx.chatId,
              titulo: '💳 Un cliente pidió el enlace para pagar',
              detalle:
                `${r.programa} — ${String(input?.concepto ?? '').replace(/_/g, ' ')}: USD ${r.montoUsd} por ${r.medio === 'paypal' ? 'PayPal' : 'Flywire'}.\n` +
                'Si no ve el pago en las próximas horas, escríbale.',
              ttlSeg: 24 * 3600,
            },
            ctx.auth,
          ).catch((e) => log.warn('aviso de pago falló', { err: String(e) }));
        }
        return r;
      }

      case 'registrar_documento_academico': {
        if (!ctx.pendingImage) {
          return {
            ok: false,
            error: 'SIN_IMAGEN',
            mensaje: 'No hay ninguna imagen nueva en este turno; solo puedes usar esto justo después de que la envíe.',
          };
        }
        // El programa sale de la FICHA, no de lo que diga la persona: es lo que determina qué
        // documento corresponde y dónde se archiva.
        const prog = ctx.crmEntities?.deal && config.ufPrograma
          ? String(((await callCrm('crm.deal.get', { id: ctx.crmEntities.deal, select: [config.ufPrograma] }, ctx.auth)) as any)?.[config.ufPrograma] ?? '')
          : '';
        const r = await registrarDocumentoAcademico(
          { dealId: ctx.crmEntities?.deal, programa: prog, base64: ctx.pendingImage.base64, mediaType: ctx.pendingImage.mediaType },
          ctx.auth,
        );
        if (r.ok) {
          await setJson(ACADEMICO_KEY(ctx.conversationId), { at: Date.now() }, 30 * 24 * 3600);
          return {
            ok: true,
            documento: r.documento,
            mensaje: `Recibiste su ${r.documento}. Confírmaselo con calidez y sigue con los antecedentes que falten.`,
          };
        }
        return {
          ok: false,
          motivo: r.motivo,
          mensaje:
            r.motivo === 'sin_programa'
              ? 'Su ficha no dice a qué programa postula, y de eso depende qué documento corresponde. Pregúntaselo y pídele que reenvíe el documento después.'
              : 'No pude guardar el documento en este momento. NO le digas que quedó registrado: pídele que lo reenvíe en un momento.',
        };
      }

      case 'registrar_datos_matricula': {
        // La foto de la cedula se guarda por su propia herramienta; aca solo se pregunta si ya llego,
        // porque sin ella la ficha no esta completa y la etapa no se mueve.
        const yaTieneFoto = await getJson<{ at: number }>(CEDULA_KEY(ctx.conversationId));
        const yaTieneAcademico = await getJson<{ at: number }>(ACADEMICO_KEY(ctx.conversationId));
        // Qué documento académico corresponde depende del nivel del programa, así que se nombra el
        // concreto en vez de pedir "un documento académico" y dejar a la persona adivinando.
        const progM = ctx.crmEntities?.deal && config.ufPrograma
          ? String(((await callCrm('crm.deal.get', { id: ctx.crmEntities.deal, select: [config.ufPrograma] }, ctx.auth)) as any)?.[config.ufPrograma] ?? '')
          : '';
        const nivelM = nivelDelPrograma(progM);
        const r = await registrarDatosMatricula(input ?? {}, ctx.crmEntities ?? {}, ctx.auth, {
          tieneFotoCedula: Boolean(yaTieneFoto),
          tieneDocumentoAcademico: Boolean(yaTieneAcademico),
          documentoQueCorresponde: nivelM ? DOCUMENTO_DE[nivelM] : undefined,
        });
        let movido = false;
        if (r.completo && ctx.crmEntities?.deal) movido = await moverAPendienteDeFirma(ctx.crmEntities.deal, ctx.auth);
        await audit({
          type: 'conocimiento',
          dialogId: ctx.conversationId,
          detail: { tema: 'ficha_matricula', guardados: r.guardados.length, faltan: r.faltan.length, completo: r.completo, movido },
        }).catch(() => {});
        return { ...r, movidoAPendienteDeFirma: movido };
      }

      case 'escalar_a_humano': {
        // Estudiante matriculado: va a SU Advisor con una tarea. No se toca la negociación comercial,
        // no se reasigna nada y el bot sigue disponible (no se entrega la sesión a la cola de ventas).
        if (input?.tipo === 'soporte_estudiante' && marca.soporteEstudiantes) {
          const est = await getJson<{ dealId: number | null; advisorId: number | null }>(ESTUDIANTE_KEY(ctx.conversationId));
          const avisada =
            est?.dealId && est.advisorId ? await crearTareaAdvisor(est.dealId, est.advisorId, String(input?.motivo ?? ''), ctx.auth) : false;
          log.info('tool escalar_a_humano (soporte estudiante)', { dialogId: ctx.conversationId, avisada });
          return {
            ok: true,
            escalado: true,
            tipo: 'soporte_estudiante',
            mensaje: avisada
              ? 'Su Advisor quedó avisada con una tarea. Confírmaselo en primera persona y con calidez, sin prometer plazos.'
              : `No hay una Advisor verificada a la que avisar: indícale el canal oficial ${CONTACTO_GENERAL}, sin prometer plazos.`,
          };
        }

        // La sesión NO se transfiere acá: se marca para que el adaptador la entregue al operador
        // DESPUÉS de enviar la respuesta. Transferirla ahora hacía que Bitrix rechazara el mensaje
        // del bot ("CANCELED No puede enviar mensajes al chat especificado"), así que el cliente que
        // pedía un asesor no recibía nada — 3 de 3 escalamientos explícitos en producción. El
        // escalamiento automático por score (ai/scoring.ts) siempre funcionó porque ahí el orden ya
        // era el correcto: primero el mensaje, después la transferencia.
        //
        // Fuera del horario del equipo NO se entrega: no hay nadie que la reciba hasta el próximo día
        // hábil, y el bot quedaba mudo mientras tanto (ver core/retenerChat.ts). La asesora igual queda con
        // la negociación y su tarea, más abajo.
        const retenida = motivoParaRetener();
        if (!retenida) {
          if (ctx.chatId) ctx.transferirAOperador = true;
          await markHumanTakeover(ctx.conversationId); // tras escalar, el bot deja de responder en esa sesión
          // ...y no solo durante las 6 h de su estado en memoria: por toda la sesión de Open Lines.
          if (marca.traspasoPorSesion) await marcarTraspaso(ctx.conversationId, ctx.sesionOpenLines ?? null, 'escalado');
          void cancelarSeguimiento(ctx.conversationId); // ya hay un asesor a cargo: no le manda seguimiento
        }

        // Si es uno de los 2 programas piloto: asigna por turno (Norte/Sur) + tarea de seguimiento —
        // no confía en la regla de "asesor por oferta" de Bitrix (no reasigna un deal que ya tiene
        // responsable; ver crm/asignacionAsesores.ts). Se ejecuta ANTES de leer el responsable más
        // abajo, para que el bot le diga al cliente el asesor recién asignado, no uno viejo.
        let fijo: Awaited<ReturnType<typeof derivarAResponsableFijo>> = false;
        if (ctx.crmEntities) {
          // Con un punto de entrada único configurado, la negociación va a ESA persona y el reparto
          // por turno no corre: son dos políticas que se excluyen.
          fijo = await derivarAResponsableFijo(ctx.crmEntities, ctx.auth);
          if (!fijo) await asignarAsesorPorTurno(ctx.crmEntities, ctx.auth);

          // Arranca el reloj: si nadie trabaja esta negociación en las próximas horas, se le avisa. No
          // si el bot se quedó atendiendo: el aviso llegaría de madrugada por un caso que no espera.
          if (ctx.crmEntities.deal && !retenida) void vigilarDerivacion(ctx.crmEntities.deal, ctx.conversationId);
        }
        // Sin asesor vigente a cargo, el chat va al punto de entrada y no a la cola de la línea.
        if (ctx.transferirAOperador) ctx.entregarA = destinoDelChat(fijo);

        // Genera (una vez) un resumen del lead para el asesor y lo deja en el CRM.
        const entityBrief = ctx.crmEntity ?? null;
        if (entityBrief) {
          const s = await getSession(ctx.conversationId);
          if (!s.briefingDone) {
            s.briefingDone = true;
            await saveSession(ctx.conversationId, s);
            void generarBriefing(ctx.conversationId, entityBrief, ctx.auth);
          }
        }

        // Trae el asesor asignado (responsable del deal) para que el bot pueda nombrarlo al cliente.
        let asesor: string | null = null;
        if (ctx.crmEntities?.deal) {
          try {
            const { responsable } = await getDealAsesores(ctx.crmEntities.deal, ctx.auth);
            if (responsable && !responsable.nombre.startsWith('Usuario ')) asesor = responsable.nombre;
          } catch (e) {
            log.warn('escalar_a_humano: no se pudo traer el responsable', { err: String(e) });
          }
        }
        log.info('tool escalar_a_humano', { motivo: input?.motivo, chatId: ctx.chatId, asesor, retenida });
        if (retenida) {
          void audit({
            type: 'derivacion_retenida',
            dialogId: ctx.conversationId,
            crmEntity: ctx.crmEntities?.deal ? `deal#${ctx.crmEntities.deal}` : undefined,
            detail: { motivo: retenida, origen: 'escalar_a_humano' },
          }).catch(() => {});
          const vuelve = cuandoVuelveElEquipo();
          return {
            ok: true,
            escalado: true,
            retenida: true,
            asesor: null,
            mensaje:
              `El caso quedó con el equipo, que lo retoma ${vuelve}. Mientras tanto TÚ sigues atendiendo esta conversación: ` +
              `díselo en primera persona y con ese plazo (por ejemplo, "lo reviso con el área y le escribo ${vuelve}"), sin contar ` +
              'que derivaste, y sigue ayudándole con todo lo que puedas responder con tus herramientas.',
          };
        }
        // El bot que habla COMO el asesor no puede anunciar que "el asesor X lo contactará": ese
        // asesor es él mismo. Pasó en el piloto ("confírmelo con Ignacio", dicho por "Ignacio"). Vale
        // también sin asesor asignado (visitante nuevo del Live Chat): ahí se presentó como el equipo
        // de admisiones, y "un asesor lo contactará" le revela una derivación que debe ser interna.
        if (marca.sePresentaComoAsesor) return { ...RESULTADO_ESCALADO_COMO_ASESOR };
        return {
          ok: true,
          escalado: true,
          asesor,
          mensaje: asesor
            ? `Conversación derivada. Informa al cliente, de forma cálida, que su asesor asignado ${asesor} lo contactará a la brevedad.`
            : 'Conversación derivada a un asesor. Informa al cliente que un asesor lo contactará a la brevedad.',
        };
      }

      default:
        return { ok: false, error: 'UNKNOWN_TOOL' };
    }
  } catch (e) {
    log.error('tool error', { name, err: String(e) });
    return { ok: false, error: String(e) };
  }
}
