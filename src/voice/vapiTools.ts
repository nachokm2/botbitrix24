import { consultarProgramas, detallePrograma } from '../core/catalogTool';
import { VOICE_PROFILE, type ChannelProfile } from '../core/channel';
import { accionInteresVoz, buscarCrmPorTelefono, crearLeadDesdeVoz } from '../crm/voiceActions';
import { actualizarDatosCliente, comentarTimeline, type DatosCliente } from '../crm/crmWrite';
import { getDealAsesores } from '../crm/directory';
import type { CrmEntities } from '../crm/entities';
import { getJson, setJson } from '../store/kv';
import { config } from '../config';
import { log } from '../log';
import type { Auth } from '../store';

// Contexto de una llamada Vapi (resuelto una vez por callId y cacheado en KV).
export type VoiceCallCtx = {
  callId: string;
  phone?: string;
  crm?: CrmEntities | null;
  /** Acciones de lead caliente (tarea + mover etapa) ya ejecutadas en esta llamada. */
  interesAccionado?: boolean;
  /** Campaña saliente: código de programa y Deal, tomados de la metadata de la llamada (Vapi). */
  programCode?: string;
  dealId?: number;
};

/** Metadatos de campaña que viajan en la creación de la llamada (Vapi) y se leen en /vapi/llm. */
export type VoiceCallMeta = { programCode?: string; dealId?: number };

const ctxKey = (callId: string) => `vapi:ctx:${callId}`;
const CTX_TTL = 2 * 60 * 60; // 2 h

/**
 * Resuelve (y cachea) el contexto CRM de la llamada. En llamadas SALIENTES de campaña, la metadata trae
 * el dealId directo (se prioriza sobre la búsqueda por teléfono); en INBOUND se busca por el número.
 */
export async function getVoiceCtx(
  callId: string,
  phone: string | undefined,
  auth: Auth,
  meta?: VoiceCallMeta,
): Promise<VoiceCallCtx> {
  const cached = await getJson<VoiceCallCtx>(ctxKey(callId));
  if (cached) return cached;
  let crm: CrmEntities | null = meta?.dealId ? { deal: meta.dealId } : null;
  if (phone) {
    const found = await buscarCrmPorTelefono(phone, auth);
    // Conserva el deal que vino en la metadata (fuente de verdad de la campaña) y suma contacto/lead.
    if (found) crm = { ...found, ...(crm ?? {}) };
  }
  const ctx: VoiceCallCtx = { callId, phone, crm, programCode: meta?.programCode, dealId: meta?.dealId };
  await setJson(ctxKey(callId), ctx, CTX_TTL);
  return ctx;
}

/**
 * Guarda los datos capturados en la llamada: busca la entidad (cache → teléfono) y ACTUALIZA;
 * si el teléfono no existe en el CRM, CREA un lead nuevo. Cachea la entidad para las siguientes
 * tool-calls de la misma llamada (así no se duplica el lead cuando el bot registra en varios pasos).
 */
async function guardarInteresVoz(ctx: VoiceCallCtx, data: DatosCliente, auth: Auth): Promise<void> {
  // Diagnóstico: qué datos llegaron del bot (¿vino programa_interes?).
  log.info('registrar_interes_crm (voz): entrada', {
    callId: ctx.callId,
    phone: ctx.phone ?? null,
    programa_interes: data?.programa_interes ?? null,
    campos: Object.keys(data ?? {}),
  });

  let ref: CrmEntities | null = ctx.crm ?? null;
  if (!ref && ctx.phone) ref = await buscarCrmPorTelefono(ctx.phone, auth);
  // Diagnóstico: qué entidad se resolvió (¿hay deal/negociación?).
  log.info('registrar_interes_crm (voz): entidad resuelta', { callId: ctx.callId, ref: ref ?? null });

  if (ref) {
    const r = await actualizarDatosCliente(ref, undefined, data, auth);
    log.info('registrar_interes_crm (voz): actualizado', { callId: ctx.callId, ...r });
  } else {
    ref = await crearLeadDesdeVoz(ctx.phone, data, auth);
  }
  if (ref && ref !== ctx.crm) {
    ctx.crm = ref;
    await setJson(ctxKey(ctx.callId), ctx, CTX_TTL);
  }

  // Acciones de "lead caliente" (UF programa + mover etapa + tarea al asesor con plazo de 15 min):
  // una sola vez por llamada, en cuanto hay programa de interés capturado.
  if (ref && data.programa_interes && !ctx.interesAccionado) {
    ctx.interesAccionado = true;
    await setJson(ctxKey(ctx.callId), ctx, CTX_TTL);
    const res = await accionInteresVoz(ref, data, auth);
    log.info('registrar_interes_crm (voz): acciones lead caliente', { callId: ctx.callId, ...res });
  } else if (ref && !data.programa_interes) {
    log.warn('registrar_interes_crm (voz): SIN programa_interes → no se actualiza UF/etapa/tarea', { callId: ctx.callId });
  }
}

/**
 * Ejecuta UNA tool call que envía Vapi durante la llamada. El resultado se devuelve
 * a Vapi como string dentro de {results:[{toolCallId, result}]}.
 * `profile` es el perfil del canal resuelto en /vapi/llm (inbound VOICE_PROFILE o saliente
 * VOICE_OUTBOUND_MMD); de él sale la presentación del catálogo por voz.
 */
export async function runVapiTool(
  name: string,
  args: any,
  ctx: VoiceCallCtx,
  auth: Auth,
  profile: ChannelProfile = VOICE_PROFILE,
): Promise<any> {
  try {
    switch (name) {
      case 'consultar_programas':
        return consultarProgramas(args, profile.catalog.consultar);
      case 'detalle_programa':
        return detallePrograma(args, profile.catalog.detalle);
      case 'registrar_interes_crm': {
        // No bloqueamos la conversación esperando a Bitrix: buscamos/creamos/actualizamos en
        // segundo plano y respondemos al instante para que la voz siga fluida.
        void guardarInteresVoz(ctx, (args ?? {}) as DatosCliente, auth).catch((e) =>
          log.warn('registrar_interes_crm (voz) async falló', { err: String(e) }),
        );
        return { ok: true, guardado: true };
      }
      case 'transferir_a_asesor': {
        let asesor: string | null = null;
        if (ctx.crm?.deal) {
          try {
            const { responsable } = await getDealAsesores(ctx.crm.deal, auth);
            if (responsable && !responsable.nombre.startsWith('Usuario ')) asesor = responsable.nombre;
          } catch (e) {
            log.warn('vapi: no se pudo traer responsable', { err: String(e) });
          }
        }
        return { transferir: true, asesor, destino: config.voiceTransferFallback || null };
      }

      // ── Tools de campaña de VOZ SALIENTE (Fase 1). Dejan registro en el timeline del Deal.
      //    El movimiento de etapa / máquina de estados / reprogramación se conecta en Fase 3-4. ──
      case 'marcar_no_interesado': {
        const motivo = String(args?.motivo ?? '').trim() || 'sin especificar';
        const optOut = /opt.?out|no.*(volver|contact)/i.test(motivo);
        if (ctx.crm) await comentarTimeline(ctx.crm, `❌ No interesado (voz IA saliente): ${motivo}`, auth).catch(() => {});
        log.info('tool marcar_no_interesado (voz)', { callId: ctx.callId, motivo, optOut });
        return { ok: true, registrado: true, optOut, mensaje: 'Registrado. Agradece cordialmente y cierra la llamada.' };
      }
      case 'marcar_no_titular': {
        const detalle = String(args?.detalle ?? '').trim();
        if (ctx.crm) {
          await comentarTimeline(ctx.crm, `☎️ No es el titular (voz IA saliente)${detalle ? ': ' + detalle : ''}`, auth).catch(() => {});
        }
        log.info('tool marcar_no_titular (voz)', { callId: ctx.callId, detalle: detalle || null });
        return { ok: true, registrado: true, mensaje: 'Registrado. Pregunta por un mejor horario o número, o cierra cordialmente.' };
      }
      case 'registrar_objecion': {
        const objecion = String(args?.objecion ?? 'otra');
        const detalle = String(args?.detalle ?? '').trim();
        if (ctx.crm) await comentarTimeline(ctx.crm, `⚠️ Objeción (${objecion})${detalle ? ': ' + detalle : ''}`, auth).catch(() => {});
        log.info('tool registrar_objecion (voz)', { callId: ctx.callId, objecion });
        return { ok: true, registrado: true, mensaje: 'Objeción registrada. Sigue manejándola con naturalidad; no cierres la llamada por esto.' };
      }
      case 'agendar_callback': {
        const cuando = String(args?.cuando ?? '').trim() || 'sin especificar';
        const telefono = String(args?.telefono ?? '').trim();
        if (ctx.crm) {
          await comentarTimeline(ctx.crm, `📅 Callback solicitado: ${cuando}${telefono ? ' · nº ' + telefono : ''}`, auth).catch(() => {});
        }
        log.info('tool agendar_callback (voz)', { callId: ctx.callId, cuando, telefono: telefono || null });
        return { ok: true, agendado: true, mensaje: 'Confirma al prospecto que lo llamaremos en ese horario y cierra cordialmente.' };
      }

      default:
        return { error: 'UNKNOWN_TOOL', name };
    }
  } catch (e) {
    log.error('runVapiTool error', { name, err: String(e) });
    return { error: String(e) };
  }
}
