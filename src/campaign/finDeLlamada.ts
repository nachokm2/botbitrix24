import { callCrm } from '../bitrix/client';
import { config } from '../config';
import { moverEtapaDeal, comentarTimeline } from '../crm/crmWrite';
import { getDealInfo } from '../crm/directory';
import { audit } from '../obs/audit';
import { log } from '../log';
import { dbGetCampaignTarget, dbUpdateCampaignTarget, dbUpdateCallAttemptByVapiId } from '../store/db';
import type { Auth } from '../store';
import type { Cierre } from '../ai/clasificadorCierre';
import type { CampaignStatus, CampaignTarget } from './types';
import { getProgram, type ProgramConfig } from './programRegistry';
import { siguienteEstado } from './stateMachine';
import { elegirAsesor } from './assignment';
import { recuperarTarget } from '../whatsapp/recuperacion';

// ── Fase 3: ejecutor del CIERRE de una llamada de campaña ──
// Aplica la máquina de estados + los efectos en Bitrix (mover etapa, asignar asesor, tarea, campos UF,
// resumen) + persiste el estado en Postgres. Reutiliza los helpers ya existentes (moverEtapaDeal,
// comentarTimeline, getDealInfo, tasks.task.add). Idempotencia y reprogramación de reintentos = Fase 4.

// Los campos UF de tipo "enumeration" en Bitrix se actualizan por el ID del item de lista, NO por el
// texto. Cacheamos el mapa {valor → ID} por campo para no releer el UF en cada escalamiento.
const enumCache = new Map<string, Record<string, string>>();
async function enumId(uf: string, value: string, auth: Auth): Promise<string | null> {
  if (!enumCache.has(uf)) {
    try {
      const fields: any[] = await callCrm('crm.deal.userfield.list', { filter: { FIELD_NAME: uf } }, auth);
      const map: Record<string, string> = {};
      for (const item of fields?.[0]?.LIST ?? []) map[String(item.VALUE)] = String(item.ID);
      enumCache.set(uf, map);
    } catch (e) {
      log.warn('enumId: no se pudo leer el UF', { uf, err: String(e) });
      enumCache.set(uf, {});
    }
  }
  return enumCache.get(uf)?.[value] ?? null;
}

/** Escribe score/clasificación/prioridad/intentos en los campos UF del Deal (best-effort). */
async function escribirUFs(pc: ProgramConfig, dealId: number, cierre: Cierre, intentos: number | undefined, auth: Auth): Promise<void> {
  const f: Record<string, unknown> = {};
  if (pc.bitrix.ufScore) f[pc.bitrix.ufScore] = cierre.leadScore;
  if (pc.bitrix.ufIntentos && intentos != null) f[pc.bitrix.ufIntentos] = intentos;
  if (pc.bitrix.ufClasificacion) {
    const id = await enumId(pc.bitrix.ufClasificacion, cierre.clasificacion, auth);
    if (id) f[pc.bitrix.ufClasificacion] = id;
  }
  if (pc.bitrix.ufPrioridad) {
    const id = await enumId(pc.bitrix.ufPrioridad, cierre.prioridad, auth);
    if (id) f[pc.bitrix.ufPrioridad] = id;
  }
  if (Object.keys(f).length) {
    try {
      await callCrm('crm.deal.update', { id: dealId, fields: f }, auth);
    } catch (e) {
      log.warn('escribirUFs falló', { dealId, err: String(e) });
    }
  }
}

/** Crea la tarea al asesor cuando se escala un lead calificado. Devuelve el id de la tarea (o undefined). */
async function crearTareaEscalamiento(pc: ProgramConfig, dealId: number, asesorId: number, cierre: Cierre, auth: Auth): Promise<number | undefined> {
  if (!asesorId) return undefined;
  const mins = config.voiceTaskMinutes || 15;
  const deadline = new Date(Date.now() + mins * 60_000).toISOString();
  const desc =
    `Prospecto calificado por el agente de voz (campaña ${pc.nombre}).\n` +
    `Clasificación: ${cierre.clasificacion} · Score: ${cierre.leadScore}/100 · Prioridad: ${cierre.prioridad}\n` +
    (cierre.objeciones.length ? `Objeciones: ${cierre.objeciones.join(', ')}\n` : '') +
    (cierre.temas.length ? `Temas: ${cierre.temas.join(', ')}\n` : '') +
    `Resumen: ${cierre.resumen || '—'}`;
  try {
    const t = await callCrm<any>(
      'tasks.task.add',
      {
        fields: {
          TITLE: `☎️ Lead ${pc.code} calificado (${cierre.clasificacion}) — contactar`,
          DESCRIPTION: desc,
          RESPONSIBLE_ID: asesorId,
          DEADLINE: deadline,
          PRIORITY: cierre.prioridad === 'alta' ? 2 : 1,
          UF_CRM_TASK: [`D_${dealId}`],
        },
      },
      auth,
    );
    const id = Number(t?.task?.id ?? t?.id);
    return id || undefined;
  } catch (e) {
    log.warn('crearTareaEscalamiento falló', { dealId, err: String(e) });
    return undefined;
  }
}

function notaResumen(cierre: Cierre): string {
  return (
    `🎯 Cierre IA (voz saliente) — ${cierre.clasificacion} · Score ${cierre.leadScore}/100 · Prioridad ${cierre.prioridad}\n` +
    (cierre.objeciones.length ? `Objeciones: ${cierre.objeciones.join(', ')}\n` : '') +
    (cierre.temas.length ? `Temas: ${cierre.temas.join(', ')}\n` : '') +
    (cierre.resumen ? cierre.resumen : '')
  );
}

export type FinLlamadaInput = {
  programCode: string;
  dealId: number;
  vapiCallId?: string;
  cierre: Cierre;
  transcriptRef?: string;
  recordingUrl?: string;
  /** El prospecto pidió expresamente no ser contactado. */
  optOut?: boolean;
};

export type FinLlamadaResult = { status: CampaignStatus; asesorId?: number; taskId?: number };

/**
 * Procesa el fin de una llamada de campaña: persiste el intento, corre la FSM, aplica los efectos en
 * Bitrix y actualiza el estado del target. `cierre` ya viene clasificado (clasificarCierre, Fase 2).
 */
export async function procesarFinDeLlamada(input: FinLlamadaInput, auth: Auth): Promise<FinLlamadaResult> {
  const pc = getProgram(input.programCode);
  if (!pc) {
    log.warn('procesarFinDeLlamada: programa desconocido', { programCode: input.programCode, dealId: input.dealId });
    return { status: 'PENDING' };
  }
  const { dealId, cierre } = input;

  const target = await dbGetCampaignTarget(dealId);
  const attemptsTotal = target?.attemptsTotal ?? 0;
  const trans = siguienteEstado(attemptsTotal, cierre, pc.agenda.maxTotal, input.optOut);

  // 1) Persistir el resultado en el registro del intento (por vapi_call_id).
  if (input.vapiCallId) {
    const patchAttempt: any = {
      answered: cierre.outcomeCode === 'answered',
      outcomeCode: cierre.outcomeCode,
      classification: cierre.clasificacion,
      leadScore: cierre.leadScore,
      factores: cierre.factores,
      objeciones: cierre.objeciones,
      temas: cierre.temas,
      resumen: cierre.resumen,
    };
    if (input.recordingUrl) patchAttempt.recordingUrl = input.recordingUrl;
    if (input.transcriptRef) patchAttempt.transcriptRef = input.transcriptRef;
    await dbUpdateCallAttemptByVapiId(input.vapiCallId, patchAttempt);
  }

  // 2) Campos UF del Deal (score/clasificación/prioridad/intentos).
  await escribirUFs(pc, dealId, cierre, attemptsTotal || undefined, auth);

  const out: FinLlamadaResult = { status: trans.status };
  const crm = { deal: dealId };

  // 3) Efectos por transición.
  if (trans.escalar) {
    if (pc.bitrix.stageInteresado) {
      await moverEtapaDeal(dealId, pc.bitrix.stageInteresado, auth).catch((e) => log.warn('escalar: mover etapa falló', { err: String(e) }));
    }
    const info = await getDealInfo(dealId, auth).catch(() => ({ responsableId: 0, categoryId: null, observerIds: [] }));
    const asesorId = await elegirAsesor(pc, info.responsableId || undefined);
    if (asesorId) {
      await callCrm('crm.deal.update', { id: dealId, fields: { ASSIGNED_BY_ID: asesorId } }, auth).catch((e) =>
        log.warn('escalar: asignar asesor falló', { err: String(e) }),
      );
      out.asesorId = asesorId;
      const taskId = await crearTareaEscalamiento(pc, dealId, asesorId, cierre, auth);
      if (taskId) out.taskId = taskId;
    }
    await comentarTimeline(crm, notaResumen(cierre), auth).catch(() => {});
    out.status = 'ESCALADO';
  } else if (trans.status === 'NO_INTERESADO') {
    if (pc.bitrix.stageNoInteresado) {
      await moverEtapaDeal(dealId, pc.bitrix.stageNoInteresado, auth).catch((e) => log.warn('no interesado: mover etapa falló', { err: String(e) }));
    }
    await comentarTimeline(crm, `❌ No interesado (campaña voz)${input.optOut ? ' · opt-out' : ''}: ${cierre.resumen || cierre.clasificacion}`, auth).catch(() => {});
  } else if (trans.status === 'NUMERO_INVALIDO') {
    await comentarTimeline(crm, '📵 Número incorrecto (campaña voz): revisar/sanear el teléfono del Deal.', auth).catch(() => {});
  } else if (trans.status === 'CALLBACK' || trans.status === 'SEGUIMIENTO' || trans.status === 'NO_TITULAR') {
    await comentarTimeline(crm, notaResumen(cierre), auth).catch(() => {});
  }
  // AGOTADO / SIN_RESPUESTA → reprogramación de reintentos y recuperación WhatsApp las maneja el scheduler (Fase 4).

  // 4) Actualizar el estado de campaña del target.
  const patch: Partial<CampaignTarget> = {
    status: out.status,
    lastOutcome: cierre.outcomeCode,
    classification: cierre.clasificacion,
    leadScore: cierre.leadScore,
    priority: cierre.prioridad,
  };
  if (input.optOut) patch.optedOut = true;
  if (cierre.outcomeCode === 'answered') patch.answeredAt = new Date().toISOString();
  if (out.asesorId) patch.asesorId = out.asesorId;
  await dbUpdateCampaignTarget(dealId, patch);

  // Si el 9º intento se agotó sin contacto → recuperación por WhatsApp (Fase 5). Upgrade AGOTADO→RECUPERACION.
  if (out.status === 'AGOTADO') {
    await recuperarTarget(pc, dealId, target?.phoneE164 ?? null, auth).catch((e) => log.warn('finDeLlamada: recuperarTarget falló', { err: String(e) }));
  }

  await audit({
    type: 'campaign.call.classified',
    crmEntity: `deal#${dealId}`,
    detail: {
      status: out.status,
      clasificacion: cierre.clasificacion,
      leadScore: cierre.leadScore,
      outcome: cierre.outcomeCode,
      asesorId: out.asesorId ?? null,
      taskId: out.taskId ?? null,
    },
  });
  log.info('campaña: fin de llamada procesado', {
    dealId,
    status: out.status,
    clasificacion: cierre.clasificacion,
    score: cierre.leadScore,
    asesorId: out.asesorId ?? null,
  });
  return out;
}
