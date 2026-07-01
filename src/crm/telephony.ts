import { callBitrix } from '../bitrix/client';
import { log } from '../log';
import type { Auth } from '../store';

// Registro de llamadas en el CRM de Bitrix24 vía telephony.externalCall.*
// IMPORTANTE: estos métodos SOLO funcionan con token de APLICACIÓN OAuth (no webhook entrante)
// y requieren el scope `telephony`. Por eso se usa callBitrix (token del app), no callCrm.
// Doc: https://apidocs.bitrix24.com/api-reference/telephony/index.html

export type CallType = 1 | 2; // 1 = saliente, 2 = entrante

export type CrmRef = { type: 'CONTACT' | 'COMPANY' | 'LEAD' | 'DEAL'; id: number };

/** Busca una entidad CRM por número de teléfono (para vincular la llamada a un cliente existente). */
export async function searchCrmByPhone(phone: string, auth: Auth): Promise<CrmRef | null> {
  try {
    const r: any = await callBitrix('telephony.externalCall.searchCrmEntities', { PHONE_NUMBER: phone }, auth);
    const first = Array.isArray(r) ? r[0] : (r?.[0] ?? null);
    if (first?.CRM_ENTITY_TYPE && first?.CRM_ENTITY_ID) {
      return { type: first.CRM_ENTITY_TYPE, id: Number(first.CRM_ENTITY_ID) };
    }
    return null;
  } catch (e) {
    log.warn('searchCrmByPhone falló', { err: String(e) });
    return null;
  }
}

export type RegisterResult = {
  callId: string | null;
  crm: CrmRef | null;
  createdLeadId?: number;
};

/** Registra el INICIO de una llamada. Devuelve CALL_ID y la entidad CRM vinculada/creada. */
export async function registerCall(
  params: { phone: string; type: CallType; userId: number; crm?: CrmRef | null; crmCreate?: boolean; startDate?: string },
  auth: Auth,
): Promise<RegisterResult> {
  const fields: Record<string, unknown> = {
    USER_ID: params.userId,
    PHONE_NUMBER: params.phone,
    TYPE: params.type,
    CRM_CREATE: params.crmCreate === false ? 0 : 1, // crea lead si no hay match por número
    SHOW: 0, // el bot no tiene pantalla; no mostramos ficha
  };
  if (params.crm) {
    fields.CRM_ENTITY_TYPE = params.crm.type;
    fields.CRM_ENTITY_ID = params.crm.id;
  }
  if (params.startDate) fields.CALL_START_DATE = params.startDate;
  try {
    const r: any = await callBitrix('telephony.externalCall.register', fields, auth);
    const crm: CrmRef | null =
      r?.CRM_ENTITY_TYPE && r?.CRM_ENTITY_ID ? { type: r.CRM_ENTITY_TYPE, id: Number(r.CRM_ENTITY_ID) } : (params.crm ?? null);
    return { callId: r?.CALL_ID ?? null, crm, createdLeadId: r?.CRM_CREATED_LEAD ? Number(r.CRM_CREATED_LEAD) : undefined };
  } catch (e) {
    log.error('registerCall falló', { err: String(e) });
    return { callId: null, crm: params.crm ?? null };
  }
}

/** Finaliza la llamada: la guarda en estadísticas y la registra como actividad en el CRM. */
export async function finishCall(
  params: { callId: string; userId: number; duration: number; statusCode?: string; cost?: number },
  auth: Auth,
): Promise<void> {
  try {
    await callBitrix(
      'telephony.externalCall.finish',
      {
        CALL_ID: params.callId,
        USER_ID: params.userId,
        DURATION: params.duration,
        STATUS_CODE: params.statusCode ?? (params.duration > 0 ? '200' : '304'),
        ...(params.cost !== undefined ? { COST: params.cost } : {}),
      },
      auth,
    );
  } catch (e) {
    log.warn('finishCall falló', { err: String(e) });
  }
}

/** Adjunta la grabación de la llamada (por URL accesible). */
export async function attachCallRecord(
  params: { callId: string; recordUrl: string; filename?: string },
  auth: Auth,
): Promise<void> {
  try {
    await callBitrix(
      'telephony.externalCall.attachRecord',
      { CALL_ID: params.callId, RECORD_URL: params.recordUrl, FILENAME: params.filename ?? `${params.callId}.mp3` },
      auth,
    );
  } catch (e) {
    log.warn('attachCallRecord falló', { err: String(e) });
  }
}
