import { buscarProgramas } from '../ai/catalog';
import { getDetalle } from '../ai/detalles';
import {
  actualizarDatosCliente,
  buscarCrmPorTelefono,
  crearLeadDesdeVoz,
  getDealAsesores,
  type CrmEntities,
  type DatosCliente,
} from '../crm/openlinesCrm';
import { getJson, setJson } from '../store/kv';
import { config } from '../config';
import { log } from '../log';
import type { Auth } from '../store';

// Contexto de una llamada Vapi (resuelto una vez por callId y cacheado en KV).
export type VoiceCallCtx = { callId: string; phone?: string; crm?: CrmEntities | null };

const ctxKey = (callId: string) => `vapi:ctx:${callId}`;
const CTX_TTL = 2 * 60 * 60; // 2 h

/** Resuelve (y cachea) el contexto CRM de la llamada buscando por el número del cliente. */
export async function getVoiceCtx(callId: string, phone: string | undefined, auth: Auth): Promise<VoiceCallCtx> {
  const cached = await getJson<VoiceCallCtx>(ctxKey(callId));
  if (cached) return cached;
  let crm: CrmEntities | null = null;
  if (phone) crm = await buscarCrmPorTelefono(phone, auth);
  const ctx: VoiceCallCtx = { callId, phone, crm };
  await setJson(ctxKey(callId), ctx, CTX_TTL);
  return ctx;
}

/**
 * Guarda los datos capturados en la llamada: busca la entidad (cache → teléfono) y ACTUALIZA;
 * si el teléfono no existe en el CRM, CREA un lead nuevo. Cachea la entidad para las siguientes
 * tool-calls de la misma llamada (así no se duplica el lead cuando el bot registra en varios pasos).
 */
async function guardarInteresVoz(ctx: VoiceCallCtx, data: DatosCliente, auth: Auth): Promise<void> {
  let ref: CrmEntities | null = ctx.crm ?? null;
  if (!ref && ctx.phone) ref = await buscarCrmPorTelefono(ctx.phone, auth);
  if (ref) {
    await actualizarDatosCliente(ref, undefined, data, auth);
  } else {
    ref = await crearLeadDesdeVoz(ctx.phone, data, auth);
  }
  if (ref && ref !== ctx.crm) {
    ctx.crm = ref;
    await setJson(ctxKey(ctx.callId), ctx, CTX_TTL);
  }
}

/**
 * Ejecuta UNA tool call que envía Vapi durante la llamada. El resultado se devuelve
 * a Vapi como string dentro de {results:[{toolCallId, result}]}.
 */
export async function runVapiTool(name: string, args: any, ctx: VoiceCallCtx, auth: Auth): Promise<any> {
  try {
    switch (name) {
      case 'consultar_programas': {
        const all = buscarProgramas(args ?? {});
        return {
          total: all.length,
          programas: all.slice(0, 5).map((p) => ({ nombre: p.nombre, tipo: p.tipo, modalidad: p.modalidad })),
          nota: all.length > 5 ? 'Hay más resultados; pide afinar por facultad o tema.' : undefined,
        };
      }
      case 'detalle_programa': {
        const d = getDetalle({ url: args?.url, nombre: args?.nombre });
        if (!d) return { encontrado: false, mensaje: 'Sin detalle cargado; ofrece derivar a un asesor.' };
        return {
          encontrado: true,
          nombre: d.nombre,
          arancel: d.arancel,
          matricula: d.matricula,
          requisitos: d.requisitos,
          descripcion: d.descripcion,
        };
      }
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
      default:
        return { error: 'UNKNOWN_TOOL', name };
    }
  } catch (e) {
    log.error('runVapiTool error', { name, err: String(e) });
    return { error: String(e) };
  }
}
