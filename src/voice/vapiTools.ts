import { buscarProgramas } from '../ai/catalog';
import { getDetalle } from '../ai/detalles';
import { actualizarDatosCliente, getDealAsesores, type CrmEntities } from '../crm/openlinesCrm';
import { searchCrmByPhone, type CrmRef } from '../crm/telephony';
import { getJson, setJson } from '../store/kv';
import { config } from '../config';
import { log } from '../log';
import type { Auth } from '../store';

// Contexto de una llamada Vapi (resuelto una vez por callId y cacheado en KV).
export type VoiceCallCtx = { callId: string; phone?: string; crm?: CrmRef | null };

const ctxKey = (callId: string) => `vapi:ctx:${callId}`;
const CTX_TTL = 2 * 60 * 60; // 2 h

/** Resuelve (y cachea) el contexto CRM de la llamada a partir del número del cliente. */
export async function getVoiceCtx(callId: string, phone: string | undefined, auth: Auth): Promise<VoiceCallCtx> {
  const cached = await getJson<VoiceCallCtx>(ctxKey(callId));
  if (cached) return cached;
  let crm: CrmRef | null = null;
  if (phone && auth?.access_token) crm = await searchCrmByPhone(phone, auth);
  const ctx: VoiceCallCtx = { callId, phone, crm };
  await setJson(ctxKey(callId), ctx, CTX_TTL);
  return ctx;
}

function mapCrm(ref?: CrmRef | null): CrmEntities {
  if (!ref) return {};
  const key = ref.type.toLowerCase() as keyof CrmEntities; // CONTACT->contact, LEAD->lead, DEAL->deal
  return { [key]: ref.id } as CrmEntities;
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
        // No bloqueamos la conversación esperando a Bitrix: guardamos en segundo plano
        // y respondemos al instante para que la voz siga fluida.
        void actualizarDatosCliente(mapCrm(ctx.crm), undefined, args ?? {}, auth).catch((e) =>
          log.warn('registrar_interes_crm (voz) async falló', { err: String(e) }),
        );
        return { ok: true, guardado: true };
      }
      case 'transferir_a_asesor': {
        let asesor: string | null = null;
        if (ctx.crm?.type === 'DEAL') {
          try {
            const { responsable } = await getDealAsesores(ctx.crm.id, auth);
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
