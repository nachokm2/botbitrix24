import { callCrm, callCrmEnvelope } from '../bitrix/client';
import { obtenerContextoLlamada, type ContextoLlamada } from '../crm/crmWrite';
import { iniciarLlamadaSaliente } from '../voice/outbound';
import {
  dbEnrollCampaignTarget, dbDueCampaignTargets, dbUpdateCampaignTarget, dbInsertCallAttempt,
} from '../store/db';
import { log } from '../log';
import type { Auth } from '../store';
import { filtroCola, type ProgramConfig } from './programRegistry';
import { planificarIntento } from './retryPolicy';
import { wallClock } from './calendar';
import { recuperarTarget } from '../whatsapp/recuperacion';

// ── Fase 4: orquestador ──
// (1) enrolarPrograma: llena campaign_target desde los deals del embudo del programa (con su teléfono).
// (2) correrOla: en cada ola, toma los targets vencidos y dispara la llamada saliente (Vapi) con la
//     metadata del programa, respetando el tope diario/total (planificarIntento) y la concurrencia.

const CONCURRENCIA = Number(process.env.CAMPAIGN_MAX_CONCURRENT ?? 5) || 5;

/** Normaliza un teléfono a E.164 (chileno por defecto). Devuelve null si no es válido. */
function normalizarE164(raw: string): string | null {
  const s = String(raw ?? '').replace(/[\s()\-.]/g, '');
  if (!s) return null;
  const e = s.startsWith('+') ? s : s.startsWith('56') ? `+${s}` : `+56${s.replace(/^0+/, '')}`;
  return /^\+\d{8,15}$/.test(e) ? e : null;
}

/** Saludo de apertura genérico por programa (usa pc.nombre; no acopla el orquestador a un programa). */
function openerCampana(pc: ProgramConfig, nombre?: string): string {
  const saludo = nombre ? `Hola, ¿hablo con ${nombre}?` : 'Hola, ¿cómo está?';
  return (
    `${saludo} Le llamo de Admisión de Postgrados de la Universidad Autónoma de Chile. ` +
    `Usted dejó su interés en el ${pc.nombre} y quería ver, rapidito, si le puedo ayudar con un par de dudas. ¿Tiene un minuto?`
  );
}

/** Lista los deals del embudo del programa (paginado), con su CONTACT_ID. */
async function listarDeals(pc: ProgramConfig, auth: Auth): Promise<{ id: number; contactId: number }[]> {
  const out: { id: number; contactId: number }[] = [];
  let start = 0;
  for (let guard = 0; guard < 40; guard++) {
    const env = await callCrmEnvelope<any[]>(
      'crm.deal.list',
      { filter: filtroCola(pc), select: ['ID', 'CONTACT_ID'], order: { ID: 'ASC' }, start },
      auth,
    );
    for (const d of env.result ?? []) out.push({ id: Number(d.ID), contactId: Number(d.CONTACT_ID) || 0 });
    if (env.next == null) break;
    start = env.next;
  }
  return out;
}

/** Teléfono (primero) de un lote de contactos, resuelto en grupos de 50. */
async function telefonosDeContactos(ids: number[], auth: Auth): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    try {
      const rows = await callCrm<any[]>('crm.contact.list', { filter: { '@ID': chunk }, select: ['ID', 'PHONE'] }, auth);
      for (const c of rows ?? []) {
        const p = Array.isArray(c.PHONE) && c.PHONE.length ? String(c.PHONE[0]?.VALUE ?? '') : '';
        if (p) map.set(Number(c.ID), p);
      }
    } catch (e) {
      log.warn('telefonosDeContactos: lote falló', { err: String(e) });
    }
  }
  return map;
}

/** Enrola en la campaña los deals del programa que tengan teléfono válido. Idempotente (upsert). */
export async function enrolarPrograma(pc: ProgramConfig, auth: Auth): Promise<{ deals: number; enrolados: number; sinTelefono: number }> {
  const deals = await listarDeals(pc, auth);
  const contactIds = [...new Set(deals.map((d) => d.contactId).filter(Boolean))];
  const tel = await telefonosDeContactos(contactIds, auth);
  let enrolados = 0;
  let sinTelefono = 0;
  for (const d of deals) {
    const e164 = normalizarE164(tel.get(d.contactId) ?? '');
    if (!e164) {
      sinTelefono++;
      continue;
    }
    const ok = await dbEnrollCampaignTarget({ dealId: d.id, programCode: pc.code, contactId: d.contactId || undefined, phoneE164: e164 });
    if (ok) enrolados++;
  }
  log.info('campaña: enrolamiento', { programa: pc.code, deals: deals.length, enrolados, sinTelefono });
  return { deals: deals.length, enrolados, sinTelefono };
}

/** Ejecuta una ola: dispara llamadas a los targets vencidos, respetando topes y concurrencia. */
export async function correrOla(
  pc: ProgramConfig,
  now: Date,
  ola: string,
  auth: Auth,
): Promise<{ intentos: number; agotados: number; sinTelefono: number }> {
  const wc = wallClock(now, pc.agenda.tz);
  const nowIso = now.toISOString();
  const due = await dbDueCampaignTargets(pc.code, nowIso, {
    maxTotal: pc.agenda.maxTotal,
    maxDias: pc.agenda.maxDias,
    limit: 200,
  });
  let intentos = 0;
  let agotados = 0;
  let sinTelefono = 0;

  for (let i = 0; i < due.length; i += CONCURRENCIA) {
    const batch = due.slice(i, i + CONCURRENCIA);
    await Promise.all(
      batch.map(async (t) => {
        const plan = planificarIntento(t, pc.agenda, wc.ymd, nowIso);
        if (!plan.llamar) {
          if (plan.agotado) {
            // Agotó los 9 intentos → recuperación: marca AGOTADO y envía la plantilla de WhatsApp (Fase 5).
            await recuperarTarget(pc, t.dealId, t.phoneE164 ?? null, auth).catch((e) =>
              log.warn('correrOla: recuperarTarget falló', { dealId: t.dealId, err: String(e) }),
            );
            agotados++;
          }
          return;
        }
        if (!t.phoneE164) {
          await dbUpdateCampaignTarget(t.dealId, { status: 'NUMERO_INVALIDO', lastOutcome: 'invalid_number' });
          sinTelefono++;
          return;
        }
        const ctx = await obtenerContextoLlamada({ deal: t.dealId, contact: t.contactId ?? undefined }, auth).catch((): ContextoLlamada => ({}));
        const r = await iniciarLlamadaSaliente(t.phoneE164, ctx, undefined, {
          metadata: { programCode: pc.code, dealId: t.dealId },
          firstMessage: openerCampana(pc, ctx.nombre),
        });
        if (r.ok && r.callId) {
          await dbUpdateCampaignTarget(t.dealId, plan.patch);
          await dbInsertCallAttempt({
            dealId: t.dealId, programCode: pc.code, attemptNo: plan.attemptNo,
            waveSlot: ola, scheduledAt: nowIso, vapiCallId: r.callId,
          });
          intentos++;
        } else {
          // Fallo al iniciar (Vapi/red): no se consume intento; se reintenta en la próxima ola.
          log.warn('correrOla: no se pudo iniciar la llamada', { dealId: t.dealId, err: r.error });
        }
      }),
    );
  }
  return { intentos, agotados, sinTelefono };
}
