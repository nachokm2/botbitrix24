import { log } from '../log';

// ── Fase 5: envío de PLANTILLA oficial de WhatsApp (proactiva, fuera de la ventana de 24h) ──
// Abstracción por proveedor (env WA_PROVIDER):
//   - 'meta'   → Meta WhatsApp Cloud API (implementado; requiere WA_CLOUD_PHONE_NUMBER_ID + WA_CLOUD_TOKEN).
//   - 'custom' → POST genérico configurable (para ChatApp u otro): WA_API_URL + WA_API_HEADERS (JSON) +
//                WA_API_BODY (plantilla con {{to}} {{template}} {{lang}} {{param0}} {{paramsJson}}).
//   - vacío    → desactivado (skip): los targets AGOTADO quedan sin WhatsApp (para trabajo manual).
// Sin dependencias del CRM: solo hace la llamada al proveedor.

export type EnviarResult = { ok: boolean; messageId?: string; error?: string; skipped?: boolean };

/** Construye el body de Meta Cloud API para un template con parámetros de body ({{1}}, {{2}}, …). PURO. */
export function construirPayloadMeta(phoneE164: string, template: string, lang: string, params: string[]): any {
  const to = String(phoneE164 ?? '').replace(/^\+/, '');
  const componentes = params.length
    ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }]
    : [];
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: { name: template, language: { code: lang }, ...(componentes.length ? { components: componentes } : {}) },
  };
}

function safeJson(s?: string): Record<string, string> | null {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Envía una plantilla de WhatsApp por el proveedor configurado. Devuelve skipped:true si está desactivado. */
export async function enviarPlantillaWhatsApp(opts: {
  phoneE164: string;
  template: string;
  lang: string;
  params: string[];
}): Promise<EnviarResult> {
  const provider = (process.env.WA_PROVIDER ?? '').toLowerCase();
  if (!provider) return { ok: false, skipped: true, error: 'WA_PROVIDER no configurado' };

  if (provider === 'meta') {
    const pnid = process.env.WA_CLOUD_PHONE_NUMBER_ID ?? '';
    const token = process.env.WA_CLOUD_TOKEN ?? '';
    if (!pnid || !token) return { ok: false, error: 'Faltan WA_CLOUD_PHONE_NUMBER_ID / WA_CLOUD_TOKEN' };
    try {
      const res = await fetch(`https://graph.facebook.com/v21.0/${pnid}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(construirPayloadMeta(opts.phoneE164, opts.template, opts.lang, opts.params)),
      });
      const json: any = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: JSON.stringify(json?.error ?? json).slice(0, 300) };
      return { ok: true, messageId: json?.messages?.[0]?.id };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  if (provider === 'custom') {
    const url = process.env.WA_API_URL ?? '';
    if (!url) return { ok: false, error: 'Falta WA_API_URL' };
    const headers = safeJson(process.env.WA_API_HEADERS) ?? { 'Content-Type': 'application/json' };
    const tpl = process.env.WA_API_BODY ?? '{"to":"{{to}}","template":"{{template}}","language":"{{lang}}","params":{{paramsJson}}}';
    const body = tpl
      .replace(/\{\{to\}\}/g, opts.phoneE164)
      .replace(/\{\{template\}\}/g, opts.template)
      .replace(/\{\{lang\}\}/g, opts.lang)
      .replace(/\{\{paramsJson\}\}/g, JSON.stringify(opts.params))
      .replace(/\{\{param0\}\}/g, opts.params[0] ?? '');
    try {
      const res = await fetch(url, { method: 'POST', headers, body });
      const txt = await res.text();
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${txt.slice(0, 200)}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  log.warn('enviarPlantillaWhatsApp: WA_PROVIDER desconocido', { provider });
  return { ok: false, error: `WA_PROVIDER desconocido: ${provider}` };
}
