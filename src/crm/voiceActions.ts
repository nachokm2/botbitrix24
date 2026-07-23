import { callCrm } from '../bitrix/client';
import { config } from '../config';
import { log } from '../log';
import type { Auth } from '../store';
import type { CrmEntities } from './entities';
import { crearLeadDesde, moverEtapaDeal, type DatosCliente } from './crmWrite';
import { getDealInfo } from './directory';
import { getDetalle } from '../ai/detalles';
import type { BitrixDuplicateResult, BitrixDealListItem, BitrixTaskAddResult } from '../bitrix/types';

// Acciones del agente de VOZ sobre el CRM: buscar cliente por teléfono, crear lead desde una
// llamada y las acciones de "lead caliente" (UF de programa + mover etapa + tarea al asesor).

/**
 * Busca una entidad CRM por número de teléfono usando el webhook admin (crm.duplicate.findbycomm),
 * SIN depender del scope `telephony`. Prioridad: Contacto (con su negociación abierta) → Lead.
 * Se usa en el agente de VOZ para vincular la llamada a un cliente ya existente antes de actualizar.
 */
export async function buscarCrmPorTelefono(phone: string, auth: Auth): Promise<CrmEntities | null> {
  const clean = String(phone || '').trim();
  if (!clean) return null;
  try {
    // 1) ¿Hay un CONTACTO con ese teléfono?
    const c = await callCrm<BitrixDuplicateResult>('crm.duplicate.findbycomm', { type: 'PHONE', entity_type: 'CONTACT', values: [clean] }, auth);
    const contactId = Array.isArray(c?.CONTACT) && c.CONTACT.length ? Number(c.CONTACT[0]) : 0;
    if (contactId) {
      const out: CrmEntities = { contact: contactId };
      // Traemos su negociación abierta más reciente para guardar ahí el "programa de interés".
      try {
        const deals = await callCrm<BitrixDealListItem[]>(
          'crm.deal.list',
          { filter: { CONTACT_ID: contactId, CLOSED: 'N' }, select: ['ID'], order: { ID: 'DESC' } },
          auth,
        );
        const dealId = Array.isArray(deals) && deals.length ? Number(deals[0].ID) : 0;
        if (dealId) out.deal = dealId;
      } catch (e) {
        log.warn('buscarCrmPorTelefono: deal.list falló', { err: String(e) });
      }
      return out;
    }
    // 2) ¿Hay un LEAD con ese teléfono?
    const l = await callCrm<BitrixDuplicateResult>('crm.duplicate.findbycomm', { type: 'PHONE', entity_type: 'LEAD', values: [clean] }, auth);
    const leadId = Array.isArray(l?.LEAD) && l.LEAD.length ? Number(l.LEAD[0]) : 0;
    if (leadId) return { lead: leadId };
    return null;
  } catch (e) {
    log.warn('buscarCrmPorTelefono falló', { err: String(e) });
    return null;
  }
}

/**
 * Crea un LEAD nuevo con los datos capturados en la llamada (cuando el teléfono no existía en el CRM).
 * Usa el teléfono de la llamada si el cliente no dictó otro (implementación compartida con
 * crearLeadWeb/crearLeadSocial — ver ALT-Media-6 de la auditoría). Nota: el UF de "programa de
 * interés" (BITRIX_UF_PROGRAMA) vive en la Negociación (Deal), no en el Lead; en un lead el
 * programa queda en el TITLE. Se escribe en el Deal vía accionInteresVoz cuando existe.
 */
export async function crearLeadDesdeVoz(
  phone: string | undefined,
  data: DatosCliente,
  auth: Auth,
): Promise<CrmEntities | null> {
  const leadId = await crearLeadDesde(
    data,
    auth,
    { sourceId: 'CALL', tituloPrefijo: 'Interés', tituloGenerico: 'Llamada IA', label: 'voz' },
    phone,
  );
  return leadId ? { lead: leadId } : null;
}

/** Etapa destino para "interesado" según el embudo: VOICE_STAGE_MAP → VOICE_STAGE_INTERESADO → stageMap[cat].alto. */
function resolveVoiceStage(categoryId: number | null): string {
  const cat = String(categoryId ?? 0);
  return config.voiceStageMap[cat] || config.voiceStageInteresado || config.stageMap[cat]?.alto || '';
}

export type AccionInteresResult = { asesorId?: number; tareaId?: number; etapa?: string };

/**
 * Acciones de "lead caliente" cuando el agente de voz capta interés en un programa. Sobre la
 * NEGOCIACIÓN (Deal) del contacto:
 *   1) escribe el programa en el UF (BITRIX_UF_PROGRAMA),
 *   2) mueve el Deal a la etapa de "interesado" (resolveVoiceStage),
 *   3) crea una TAREA al asesor responsable con plazo (VOICE_TASK_MINUTES, default 15 min).
 * Si solo hay lead/contacto (sin Deal), crea la tarea al asesor de respaldo (VOICE_TASK_FALLBACK_USER)
 * y omite UF/etapa (esos campos viven en el Deal). Best-effort: cada paso falla de forma aislada.
 */
export async function accionInteresVoz(ref: CrmEntities, data: DatosCliente, auth: Auth): Promise<AccionInteresResult> {
  const out: AccionInteresResult = {};
  const dealId = ref.deal;
  let asesorId = config.voiceTaskUserId || 0;
  let categoryId: number | null = null;

  if (dealId) {
    const info = await getDealInfo(dealId, auth);
    if (info.responsableId) asesorId = info.responsableId;
    categoryId = info.categoryId;

    // 1) Programa de interés (+ link al brochure, si el UF está configurado) en el Deal.
    if (config.ufPrograma && data.programa_interes) {
      try {
        const fields: any = { [config.ufPrograma]: data.programa_interes };
        if (config.ufBrochure) {
          const brochureUrl = getDetalle({ nombre: data.programa_interes })?.brochureUrl;
          if (brochureUrl) fields[config.ufBrochure] = brochureUrl;
        }
        await callCrm('crm.deal.update', { id: dealId, fields }, auth);
      } catch (e) {
        log.warn('accionInteresVoz: UF programa falló', { err: String(e) });
      }
    }

    // 2) Mover de etapa.
    const stage = resolveVoiceStage(categoryId);
    if (stage) {
      try {
        await moverEtapaDeal(dealId, stage, auth);
        out.etapa = stage;
      } catch (e) {
        log.warn('accionInteresVoz: mover etapa falló', { err: String(e) });
      }
    }
  }

  // 3) Tarea al asesor con plazo. Vinculada al Deal (o al lead/contacto si no hay Deal).
  if (asesorId) {
    const mins = config.voiceTaskMinutes || 15;
    const deadline = new Date(Date.now() + mins * 60_000).toISOString();
    const nombre = [data.nombre, data.apellido].filter(Boolean).join(' ').trim() || 'el prospecto';
    const prog = data.programa_interes ? ` – ${data.programa_interes}` : '';
    const link = dealId ? `D_${dealId}` : ref.contact ? `C_${ref.contact}` : ref.lead ? `L_${ref.lead}` : '';
    try {
      const t = await callCrm<BitrixTaskAddResult>(
        'tasks.task.add',
        {
          fields: {
            TITLE: `☎️ Llamar en ${mins} min: ${nombre}${prog}`,
            DESCRIPTION:
              `Lead caliente detectado por el agente de voz (IA).\n` +
              `Programa de interés: ${data.programa_interes ?? '—'}\n` +
              `Teléfono: ${data.telefono ?? '—'} · Correo: ${data.email ?? '—'}\n` +
              `Contactar dentro de ${mins} minutos.`,
            RESPONSIBLE_ID: asesorId,
            DEADLINE: deadline,
            PRIORITY: 2, // alta
            ...(link ? { UF_CRM_TASK: [link] } : {}),
          },
        },
        auth,
      );
      const taskId = Number(t?.task?.id ?? t?.id);
      if (taskId) out.tareaId = taskId;
      out.asesorId = asesorId;
    } catch (e) {
      log.warn('accionInteresVoz: crear tarea falló', { err: String(e) });
    }
  } else {
    log.warn('accionInteresVoz: sin asesor (deal sin responsable y sin VOICE_TASK_FALLBACK_USER); no se crea tarea');
  }

  return out;
}
