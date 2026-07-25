import { obtenerContextoLlamada, moverEtapaDeal, comentarTimeline, type ContextoLlamada } from '../crm/crmWrite';
import { dbUpdateCampaignTarget } from '../store/db';
import { audit } from '../obs/audit';
import { log } from '../log';
import type { Auth } from '../store';
import type { ProgramConfig } from '../campaign/programRegistry';
import { enviarPlantillaWhatsApp } from './template';

// ── Fase 5: recuperación de un target AGOTADO ──
// Tras 9 intentos sin contacto, marca AGOTADO y — si hay plantilla configurada — envía la plantilla
// oficial de WhatsApp, mueve el Deal a la etapa de recuperación y lo deja para campañas futuras.
// Si la recuperación WhatsApp está desactivada (sin plantilla/proveedor), el Deal queda en AGOTADO.

/**
 * Procesa un target agotado. `phoneE164` puede ser null (sin teléfono → solo marca AGOTADO).
 * Idempotente en la práctica: `whatsapp_sent` evita reenvíos si se vuelve a llamar.
 */
export async function recuperarTarget(
  pc: ProgramConfig,
  dealId: number,
  phoneE164: string | null,
  auth: Auth,
  nombre?: string,
): Promise<{ enviado: boolean }> {
  await dbUpdateCampaignTarget(dealId, { status: 'AGOTADO' });

  if (!pc.whatsapp.templateName || !phoneE164) return { enviado: false };

  if (!nombre) {
    const ctx = await obtenerContextoLlamada({ deal: dealId }, auth).catch((): ContextoLlamada => ({}));
    nombre = ctx.nombre;
  }
  const params = pc.whatsapp.params.map((p) => (p === 'nombre' ? (nombre ?? '') : ''));

  const r = await enviarPlantillaWhatsApp({
    phoneE164,
    template: pc.whatsapp.templateName,
    lang: pc.whatsapp.templateLang,
    params,
  });

  if (r.ok) {
    await dbUpdateCampaignTarget(dealId, { status: 'RECUPERACION', whatsappSent: true });
    if (pc.bitrix.stageRecuperacion) {
      await moverEtapaDeal(dealId, pc.bitrix.stageRecuperacion, auth).catch((e) => log.warn('recuperación: mover etapa falló', { err: String(e) }));
    }
    await comentarTimeline({ deal: dealId }, `📲 Plantilla de WhatsApp de recuperación enviada (${pc.whatsapp.templateName}).`, auth).catch(() => {});
    await audit({ type: 'campaign.whatsapp.sent', crmEntity: `deal#${dealId}`, detail: { template: pc.whatsapp.templateName, messageId: r.messageId ?? null } });
    log.info('campaña: recuperación WhatsApp enviada', { dealId, template: pc.whatsapp.templateName });
  } else if (!r.skipped) {
    log.warn('campaña: recuperación WhatsApp falló', { dealId, err: r.error });
  }
  return { enviado: r.ok };
}
