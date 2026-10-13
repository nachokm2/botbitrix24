import { callCrm } from '../bitrix/client';
import { config } from '../config';
import { esAsesorValido } from './equipo';
import { log } from '../log';
import type { Auth } from '../store';
import type { BitrixDeal, BitrixUser } from '../bitrix/types';

// Directorio CRM: lectura de negociaciones (deal) y resolución de usuarios/asesores de Bitrix.

export type Responsable = {
  id: number;
  nombre: string;
  email?: string;
  telefono?: string;
  activo?: boolean;
  /** Departamentos de la estructura de Bitrix (UF_DEPARTMENT): define a qué equipo pertenece. */
  departamentos?: number[];
};

export type DealInfo = {
  categoryId: number | null;
  /** Responsable de la negociación (ASSIGNED_BY_ID): el asesor "dueño" del deal. */
  responsableId: number | null;
  /** Observadores (OBSERVER_IDS): otros asesores que también ven el deal. */
  observerIds: number[];
  titulo?: string;
  stageId?: string;
};

const toIdArray = (raw: any): number[] =>
  (Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === '' ? [] : String(raw).split(','))
    .map((x: any) => Number(x))
    .filter((n: number) => Number.isFinite(n) && n > 0);

/**
 * Lee un deal y devuelve embudo + responsable (ASSIGNED_BY_ID) + observadores (OBSERVER_IDS)
 * en una sola llamada `crm.deal.get`. Bitrix24 asigna el responsable según sus reglas de
 * distribución; los observadores suelen ser el "segundo asesor" que también ve el programa.
 */
export async function getDealInfo(dealId: number, auth: Auth): Promise<DealInfo> {
  try {
    const r = await callCrm<BitrixDeal>('crm.deal.get', { id: dealId }, auth);
    const cat = r?.CATEGORY_ID ?? r?.categoryId;
    const asg = r?.ASSIGNED_BY_ID ?? r?.assignedById;
    return {
      categoryId: cat !== undefined && cat !== null ? Number(cat) : null,
      responsableId: asg ? Number(asg) : null,
      observerIds: toIdArray(r?.OBSERVER_IDS ?? r?.observerIds),
      titulo: r?.TITLE,
      stageId: r?.STAGE_ID,
    };
  } catch (e) {
    log.warn('getDealInfo falló', { err: String(e) });
    return { categoryId: null, responsableId: null, observerIds: [] };
  }
}

/** Devuelve el CATEGORY_ID (embudo) de un deal, para elegir la etapa correcta del mapa. */
export async function getDealCategory(dealId: number, auth: Auth): Promise<number | null> {
  return (await getDealInfo(dealId, auth)).categoryId;
}

/**
 * Resuelve nombre/email de uno o varios usuarios de Bitrix (asesores).
 * Requiere que el webhook entrante tenga el scope `user` (Usuarios); si no, devuelve solo el id.
 */
export async function getUsuarios(ids: number[], auth: Auth): Promise<Responsable[]> {
  const uniq = Array.from(new Set(ids.filter((n) => Number.isFinite(n) && n > 0)));
  const out: Responsable[] = [];
  for (const id of uniq) {
    try {
      const raw = await callCrm<BitrixUser | BitrixUser[] | { result?: BitrixUser[] }>('user.get', { ID: id }, auth);
      let u: BitrixUser | undefined;
      if (Array.isArray(raw)) u = raw[0];
      else if (raw && 'result' in raw && Array.isArray(raw.result)) u = raw.result[0];
      else u = raw as BitrixUser;
      if (u && (u.NAME || u.LAST_NAME || u.EMAIL)) {
        const nombre = [u.NAME, u.LAST_NAME].filter(Boolean).join(' ').trim() || String(u.EMAIL) || `Usuario ${id}`;
        const email = Array.isArray(u.EMAIL) ? u.EMAIL?.[0]?.VALUE : u.EMAIL;
        out.push({
          id,
          nombre,
          email,
          telefono: u.PERSONAL_MOBILE || undefined,
          activo: u.ACTIVE !== false,
          departamentos: toIdArray(u.UF_DEPARTMENT),
        });
      } else {
        out.push({ id, nombre: `Usuario ${id}` });
      }
    } catch (e) {
      log.warn('getUsuarios: user.get falló (¿falta scope user en el webhook?)', { id, err: String(e) });
      out.push({ id, nombre: `Usuario ${id}` });
    }
  }
  return out;
}

/**
 * ¿Este ID de usuario es un EMPLEADO real del portal (asesor/operador)? `user.get` solo devuelve
 * NAME/LAST_NAME/EMAIL para cuentas de verdad; los participantes externos de Open Lines (clientes
 * por WhatsApp/IG/etc.) tienen un ID numérico pero NO existen como usuario del portal. Fail-open
 * (false) ante cualquier error: mejor tratar como cliente por error que silenciar al bot con un
 * cliente real (ver botEvents.ts: detección del primer mensaje de un chat reactivado).
 */
export async function esEmpleadoBitrix(id: number, auth: Auth): Promise<boolean> {
  if (!Number.isFinite(id) || id <= 0) return false;
  try {
    const raw = await callCrm<BitrixUser | BitrixUser[] | { result?: BitrixUser[] }>('user.get', { ID: id }, auth);
    let u: BitrixUser | undefined;
    if (Array.isArray(raw)) u = raw[0];
    else if (raw && 'result' in raw && Array.isArray(raw.result)) u = raw.result[0];
    else u = raw as BitrixUser;
    return !!(u && (u.NAME || u.LAST_NAME || u.EMAIL));
  } catch (e) {
    log.warn('esEmpleadoBitrix: user.get falló (se asume que NO es empleado)', { id, err: String(e) });
    return false;
  }
}

/** Responsable + observadores de un deal, ya con nombre/email resueltos. */
export async function getDealAsesores(
  dealId: number,
  auth: Auth,
): Promise<{ responsable: Responsable | null; observadores: Responsable[]; info: DealInfo }> {
  const info = await getDealInfo(dealId, auth);
  const ids = [info.responsableId, ...info.observerIds].filter((x): x is number => !!x);
  const usuarios = await getUsuarios(ids, auth);
  const byId = new Map(usuarios.map((u) => [u.id, u]));
  return {
    responsable: info.responsableId ? (byId.get(info.responsableId) ?? { id: info.responsableId, nombre: `Usuario ${info.responsableId}` }) : null,
    observadores: info.observerIds.map((oid) => byId.get(oid) ?? { id: oid, nombre: `Usuario ${oid}` }),
    info,
  };
}

// Identidad del asesor para que el bot se presente como él (marca.sePresentaComoAsesor). Se cachea
// por negociación porque getDealAsesores son DOS llamadas a Bitrix (crm.deal.get + user.get) y el
// limitador las serializa: sin caché, cada turno de cada conversación pagaba esa latencia.
const IDENTIDAD_TTL_MS = 5 * 60 * 1000;
const identidadCacheK = new Map<string, { at: number; valor: IdentidadAsesor | null }>();

export type IdentidadAsesor = { nombre: string; email?: string; telefono?: string };

/** Nombre, correo y teléfono del responsable de una NEGOCIACIÓN, un LEAD o un CONTACTO — en ese orden
 *  de preferencia. El lead importa: la mitad de las conversaciones nuevas de WhatsApp entran como
 *  lead sin negociación todavía, y mirando solo deals el bot se quedaba sin asesor que adoptar y se
 *  presentaba de forma genérica justamente en el primer contacto. null si no hay responsable
 *  resoluble o Bitrix no devuelve un nombre real. */
export async function getIdentidadAsesor(
  entidades: { deal?: number; lead?: number; contact?: number },
  auth: Auth,
): Promise<IdentidadAsesor | null> {
  const metodo = entidades.deal
    ? (['crm.deal.get', entidades.deal] as const)
    : entidades.lead
      ? (['crm.lead.get', entidades.lead] as const)
      : entidades.contact
        ? (['crm.contact.get', entidades.contact] as const)
        : null;
  if (!metodo) return null;
  const clave = `${metodo[0]}#${metodo[1]}`;
  const previo = identidadCacheK.get(clave);
  if (previo && Date.now() - previo.at < IDENTIDAD_TTL_MS) return previo.valor;

  let valor: IdentidadAsesor | null = null;
  try {
    const r = await callCrm<any>(metodo[0], { id: metodo[1] }, auth);
    // Una negociación de OTRO embudo (otra marca del mismo portal) no presta su responsable: el bot
    // de Carver se presentaba con el nombre de un ejecutivo de Postgrados cuando Bitrix enlazaba el
    // chat a una ficha vieja de esa persona.
    const categoria = r?.CATEGORY_ID ?? r?.categoryId;
    const embudoAjeno =
      metodo[0] === 'crm.deal.get' &&
      config.embudosPropios.length > 0 &&
      !config.embudosPropios.includes(Number(categoria ?? -1));
    const asignado = Number(r?.ASSIGNED_BY_ID ?? r?.assignedById ?? 0);
    if (!asignado || embudoAjeno) {
      identidadCacheK.set(clave, { at: Date.now(), valor: null });
      return null;
    }
    const [u] = await getUsuarios([asignado], auth);
    // "Usuario 12345" es el relleno cuando Bitrix no devuelve el usuario: con eso el bot se
    // presentaría como "Usuario 12345", que es peor que no presentarse con nombre. Y solo se adopta
    // a quien de verdad puede atender: persona activa del equipo de la marca, no un robot ni el
    // responsable por defecto del embudo (ver crm/equipo.ts).
    if (u && !u.nombre.startsWith('Usuario ') && esAsesorValido(u)) {
      valor = { nombre: u.nombre, email: u.email, telefono: u.telefono };
    }
  } catch (e) {
    log.warn('getIdentidadAsesor falló', { err: String(e), entidad: clave });
    return previo?.valor ?? null; // ante un fallo puntual, se prefiere la identidad anterior
  }
  identidadCacheK.set(clave, { at: Date.now(), valor });
  return valor;
}

/** Datos de contacto que el CRM YA tiene de esta persona. */
export type DatosConocidos = { nombre?: string; email?: string; telefono?: string };

const conocidosCache = new Map<number, { at: number; valor: DatosConocidos }>();

/**
 * Nombre, correo y teléfono que ya figuran en el CONTACTO de Bitrix.
 *
 * Sin esto el bot pedía el nombre en cada mensaje aunque el contacto existiera desde la campaña que
 * originó la conversación. Un cliente real lo reclamó: "¿por qué me pides mi nombre si lo debes
 * tener?" — y tenía razón. Preguntar lo que ya se sabe desgasta y resta credibilidad.
 */
export async function getDatosConocidos(contactId: number, auth: Auth): Promise<DatosConocidos> {
  const previo = conocidosCache.get(contactId);
  if (previo && Date.now() - previo.at < IDENTIDAD_TTL_MS) return previo.valor;
  let valor: DatosConocidos = {};
  try {
    const c = await callCrm<any>('crm.contact.get', { id: contactId }, auth);
    const nombre = [c?.NAME, c?.LAST_NAME].filter(Boolean).join(' ').trim();
    const email = Array.isArray(c?.EMAIL) ? c.EMAIL[0]?.VALUE : undefined;
    const telefono = Array.isArray(c?.PHONE) ? c.PHONE[0]?.VALUE : undefined;
    valor = { nombre: nombre || undefined, email, telefono };
  } catch (e) {
    log.warn('getDatosConocidos falló', { err: String(e), contactId });
    return previo?.valor ?? {};
  }
  conocidosCache.set(contactId, { at: Date.now(), valor });
  return valor;
}

const conocidosLeadCache = new Map<number, { at: number; valor: DatosConocidos }>();

/** Nombre, correo y teléfono que ya figuran en un LEAD. */
async function getDatosConocidosLead(leadId: number, auth: Auth): Promise<DatosConocidos> {
  const previo = conocidosLeadCache.get(leadId);
  if (previo && Date.now() - previo.at < IDENTIDAD_TTL_MS) return previo.valor;
  let valor: DatosConocidos = {};
  try {
    const l = await callCrm<any>('crm.lead.get', { id: leadId }, auth);
    const nombre = [l?.NAME, l?.LAST_NAME].filter(Boolean).join(' ').trim();
    const email = Array.isArray(l?.EMAIL) ? l.EMAIL[0]?.VALUE : undefined;
    const telefono = Array.isArray(l?.PHONE) ? l.PHONE[0]?.VALUE : undefined;
    valor = { nombre: nombre || undefined, email, telefono };
  } catch (e) {
    log.warn('getDatosConocidosLead falló', { err: String(e), leadId });
    return previo?.valor ?? {};
  }
  conocidosLeadCache.set(leadId, { at: Date.now(), valor });
  return valor;
}

/** Igual que getDatosConocidos pero aceptando las entidades del chat: si no hay contacto vinculado
 *  —pasa cuando el chat solo trae la negociación— lo busca a través de ella. Sin esto el bot se
 *  quedaba sin los datos justo en las conversaciones que vienen de una campaña, que son las que SÍ
 *  tienen ficha creada. */
export async function getDatosConocidosDeEntidades(
  entidades: { contact?: number; deal?: number; lead?: number },
  auth: Auth,
): Promise<DatosConocidos> {
  if (entidades.contact) return getDatosConocidos(entidades.contact, auth);
  // Un chat nuevo de WhatsApp suele entrar como LEAD sin contacto: el lead ya trae el teléfono de
  // WhatsApp (y a veces nombre y correo de un formulario). Sin leerlo, el bot volvía a pedir datos
  // que la ficha ya tenía.
  if (!entidades.deal && entidades.lead && config.datosConocidosDesdeLead) return getDatosConocidosLead(entidades.lead, auth);
  if (!entidades.deal) return {};
  try {
    const d = await callCrm<any>('crm.deal.get', { id: entidades.deal }, auth);
    const cid = Number(d?.CONTACT_ID ?? 0);
    return cid > 0 ? getDatosConocidos(cid, auth) : {};
  } catch (e) {
    log.warn('getDatosConocidosDeEntidades: no se pudo resolver el contacto del deal', { err: String(e), deal: entidades.deal });
    return {};
  }
}
