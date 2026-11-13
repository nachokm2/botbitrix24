import { callCrm } from '../bitrix/client';
import { config } from '../config';
import { log } from '../log';
import { audit } from '../obs/audit';
import { getJson, setJson, once } from '../store/kv';
import type { Auth } from '../store';
import type { BitrixDuplicateResult } from '../bitrix/types';
import type { CrmEntities } from './entities';

/**
 * Negociación para quien llega al modo internacional (core/internacional.ts) sin una en el embudo.
 *
 * Pedido del usuario del 13-11-2026, por el anuncio de Meta que lleva a WhatsApp desde India: un número
 * nuevo que escribe al WhatsApp de Carver queda, a lo sumo, como lead —en la revisión de ese día, 6 de
 * 77 chats llegaron así—, sin negociación en ningún embudo, y en ese modo no hay asesor que la cree.
 * Con el primer mensaje del modo, antes de que el bot responda, se crea en la etapa configurada (la
 * etapa «Carver» del embudo 73), con el responsable configurado (el usuario, 4173).
 *
 * - Si el chat ya trae una negociación en ese embudo, no se crea nada.
 * - El contacto se reutiliza: el del chat, el del lead, o uno con el mismo teléfono. Si no hay, se crea.
 * - Se recuerda por conversación: los mensajes siguientes usan la misma negociación sin consultar a
 *   Bitrix, y dos mensajes seguidos no crean dos.
 * - Nunca lanza: si Bitrix falla, el bot responde igual, con las entidades que había.
 */

const KEY = (dialogId: string) => `internacional:negociacion:${dialogId}`;
const TTL_SEG = 30 * 86400; // lo mismo que dura la marca del modo internacional

/** El embudo de una etapa: "C73:UC_173429" → 73. */
export function embudoDeEtapa(etapa: string): number | null {
  const m = /^C(\d+):/.exec(etapa);
  return m ? Number(m[1]) : null;
}

/** Un contacto existente con ese teléfono, o 0. */
async function contactoPorTelefono(telefono: string, auth: Auth): Promise<number> {
  try {
    const r = await callCrm<BitrixDuplicateResult>('crm.duplicate.findbycomm', { type: 'PHONE', entity_type: 'CONTACT', values: [telefono] }, auth);
    return Array.isArray(r?.CONTACT) && r.CONTACT.length ? Number(r.CONTACT[0]) : 0;
  } catch (e) {
    log.warn('negociación internacional: no se pudo buscar el contacto por teléfono', { err: String(e) });
    return 0;
  }
}

const nombreDe = (x: any) => [x?.NAME, x?.LAST_NAME].map((s) => String(s ?? '').trim()).filter(Boolean).join(' ');

export async function asegurarNegociacionInternacional(a: {
  dialogId: string;
  entidades: CrmEntities;
  telefono: () => Promise<string | null>;
  auth: Auth;
}): Promise<CrmEntities> {
  const etapa = config.internacionalEtapaNegociacion;
  const embudo = etapa ? embudoDeEtapa(etapa) : null;
  if (!etapa || embudo === null) return a.entidades;

  const guardada = await getJson<{ deal: number; contact?: number }>(KEY(a.dialogId)).catch(() => null);
  if (guardada?.deal) {
    return { ...a.entidades, deal: guardada.deal, ...(guardada.contact && !a.entidades.contact ? { contact: guardada.contact } : {}) };
  }

  try {
    if (a.entidades.deal) {
      const d: any = await callCrm('crm.deal.get', { id: a.entidades.deal, select: ['CATEGORY_ID'] }, a.auth);
      if (Number(d?.CATEGORY_ID) === embudo) {
        await setJson(KEY(a.dialogId), { deal: a.entidades.deal, contact: a.entidades.contact }, TTL_SEG);
        return a.entidades;
      }
    }
    // Un solo intento por conversación, aunque lleguen dos mensajes casi juntos.
    if (!(await once(`${KEY(a.dialogId)}:creando`, 120))) return a.entidades;

    const telefono = (await a.telefono().catch(() => null)) || '';
    let nombre = '';
    let contactId = a.entidades.contact ?? 0;
    if (!contactId && a.entidades.lead) {
      const l: any = await callCrm('crm.lead.get', { id: a.entidades.lead }, a.auth).catch(() => null);
      contactId = Number(l?.CONTACT_ID) || 0;
      nombre = nombreDe(l);
    }
    if (!contactId && telefono) contactId = await contactoPorTelefono(telefono, a.auth);
    const responsable = config.internacionalResponsable || config.internacionalAvisarA[0] || 0;
    if (contactId && !nombre) {
      const c: any = await callCrm('crm.contact.get', { id: contactId }, a.auth).catch(() => null);
      nombre = nombreDe(c);
    }
    if (!contactId) {
      const campos: any = { NAME: nombre || 'WhatsApp', SOURCE_ID: 'OTHER', OPENED: 'Y' };
      if (telefono) campos.PHONE = [{ VALUE: telefono, VALUE_TYPE: 'MOBILE' }];
      if (responsable) campos.ASSIGNED_BY_ID = responsable;
      contactId = Number(await callCrm<string | number>('crm.contact.add', { fields: campos }, a.auth)) || 0;
    }

    const programa = config.internacionalPrograma || 'Programa internacional';
    const campos: any = {
      TITLE: `${programa} – ${nombre || telefono || 'WhatsApp'}`,
      CATEGORY_ID: embudo,
      STAGE_ID: etapa,
      SOURCE_ID: 'OTHER',
      OPENED: 'Y',
      COMMENTS: 'Llegó por WhatsApp al programa internacional (anuncio de Meta). La conversación la atiende el bot.',
    };
    if (responsable) campos.ASSIGNED_BY_ID = responsable;
    if (contactId) campos.CONTACT_ID = contactId;
    if (a.entidades.lead) campos.LEAD_ID = a.entidades.lead;
    if (config.ufPrograma && config.internacionalPrograma) campos[config.ufPrograma] = config.internacionalPrograma;
    const dealId = Number(await callCrm<string | number>('crm.deal.add', { fields: campos, params: { REGISTER_SONET_EVENT: 'Y' } }, a.auth)) || 0;
    if (!dealId) return a.entidades;

    await setJson(KEY(a.dialogId), { deal: dealId, contact: contactId || undefined }, TTL_SEG);
    void audit({
      type: 'negociacion_internacional',
      dialogId: a.dialogId,
      crmEntity: `deal#${dealId}`,
      detail: { etapa, contacto: contactId || null, lead: a.entidades.lead ?? null, otraNegociacion: a.entidades.deal ?? null },
    }).catch(() => {});
    log.info('negociación internacional creada', { dialogId: a.dialogId, dealId, contactId, etapa });
    return { ...a.entidades, deal: dealId, ...(contactId ? { contact: contactId } : {}) };
  } catch (e) {
    log.warn('negociación internacional: no se pudo crear', { err: String(e), dialogId: a.dialogId });
    return a.entidades;
  }
}
