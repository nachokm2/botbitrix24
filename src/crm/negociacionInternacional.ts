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

const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DOS_DIAS_MS = 2 * 86400_000;
const reciente = (fecha: unknown, ms = DOS_DIAS_MS) => {
  const t = Date.parse(String(fecha ?? ''));
  return Number.isFinite(t) && Date.now() - t < ms;
};

/**
 * La negociación que Bitrix crea sola al convertir el lead de la línea abierta, en el mismo embudo y
 * repartida entre los asesores. Del 14 al 16-11-2026 cada persona de India quedó con dos: la del bot y
 * esa (129, casi todas en «Info Urgente» y a nombre de siete asesores). Ahora se toma esa en vez de crear
 * otra. Bitrix la crea un segundo después del lead: si todavía no está, se espera una vez. Se toma aunque
 * ya esté cerrada: las que le tocan a una asesora las pasa un robot a «RMKT» (cerrada) en el acto. Para
 * no tocar nada que haya trabajado una persona, solo una creada hace menos de 30 minutos.
 */
async function negociacionDelLead(lead: number, embudo: number, auth: Auth): Promise<any | null> {
  for (let intento = 0; intento < 2; intento++) {
    const r: any = await callCrm(
      'crm.deal.list',
      { filter: { LEAD_ID: lead, CATEGORY_ID: embudo }, select: ['ID', 'CONTACT_ID', 'DATE_CREATE', 'CLOSED', 'STAGE_ID', 'ASSIGNED_BY_ID'] },
      auth,
    ).catch(() => null);
    const d = Array.isArray(r) ? r.find((x: any) => reciente(x?.DATE_CREATE, 30 * 60_000)) : null;
    if (d) return d;
    if (intento === 0) await pausa(process.env.NODE_ENV === 'test' ? 0 : 3000);
  }
  return null;
}

/** Deja a nombre del responsable lo que creó la línea abierta: el lead siempre, el contacto si es nuevo. */
async function asignarAlResponsable(responsable: number, lead: number | undefined, contactId: number, auth: Auth): Promise<void> {
  if (!responsable) return;
  if (lead) {
    await callCrm('crm.lead.update', { id: lead, fields: { ASSIGNED_BY_ID: responsable }, params: { REGISTER_SONET_EVENT: 'N' } }, auth).catch((e) =>
      log.warn('negociación internacional: no se pudo asignar el lead', { err: String(e), lead }),
    );
  }
  if (contactId) {
    // Solo un contacto recién creado: uno antiguo puede ser de alguien que ya atiende otro asesor.
    const c: any = await callCrm('crm.contact.get', { id: contactId }, auth).catch(() => null);
    if (c && Number(c.ASSIGNED_BY_ID) !== responsable && reciente(c.DATE_CREATE)) {
      await callCrm('crm.contact.update', { id: contactId, fields: { ASSIGNED_BY_ID: responsable }, params: { REGISTER_SONET_EVENT: 'N' } }, auth).catch((e) =>
        log.warn('negociación internacional: no se pudo asignar el contacto', { err: String(e), contactId }),
      );
    }
  }
}

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

    const responsable = config.internacionalResponsable || config.internacionalAvisarA[0] || 0;

    // La que creó Bitrix al convertir el lead: se toma, se pone a nombre del responsable y se pasa a la
    // etapa del modo. Salir de «Info Urgente» corta además los robots de esa etapa.
    const delLead = a.entidades.lead ? await negociacionDelLead(a.entidades.lead, embudo, a.auth) : null;
    if (delLead) {
      const dealId = Number(delLead.ID);
      const contacto = a.entidades.contact || Number(delLead.CONTACT_ID) || 0;
      const campos: any = { STAGE_ID: etapa };
      if (responsable) campos.ASSIGNED_BY_ID = responsable;
      await callCrm('crm.deal.update', { id: dealId, fields: campos, params: { REGISTER_SONET_EVENT: 'N' } }, a.auth);
      await asignarAlResponsable(responsable, a.entidades.lead, contacto, a.auth);
      await setJson(KEY(a.dialogId), { deal: dealId, contact: contacto || undefined }, TTL_SEG);
      void audit({
        type: 'negociacion_internacional',
        dialogId: a.dialogId,
        crmEntity: `deal#${dealId}`,
        detail: { etapa, contacto: contacto || null, lead: a.entidades.lead ?? null, reutilizada: true, etapaAnterior: delLead.STAGE_ID, responsableAnterior: Number(delLead.ASSIGNED_BY_ID) || null },
      }).catch(() => {});
      log.info('negociación internacional: se tomó la que creó Bitrix', { dialogId: a.dialogId, dealId, etapaAnterior: delLead.STAGE_ID });
      return { ...a.entidades, deal: dealId, ...(contacto ? { contact: contacto } : {}) };
    }

    const telefono = (await a.telefono().catch(() => null)) || '';
    let nombre = '';
    let contactId = a.entidades.contact ?? 0;
    if (!contactId && a.entidades.lead) {
      const l: any = await callCrm('crm.lead.get', { id: a.entidades.lead }, a.auth).catch(() => null);
      contactId = Number(l?.CONTACT_ID) || 0;
      nombre = nombreDe(l);
    }
    if (!contactId && telefono) contactId = await contactoPorTelefono(telefono, a.auth);
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
    await asignarAlResponsable(responsable, a.entidades.lead, contactId, a.auth);

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
