import { callCrm } from '../bitrix/client';
import { log } from '../log';
import type { Auth } from '../store';
import type { BitrixDeal, BitrixUser } from '../bitrix/types';

// Directorio CRM: lectura de negociaciones (deal) y resolución de usuarios/asesores de Bitrix.

export type Responsable = { id: number; nombre: string; email?: string; activo?: boolean };

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
        out.push({ id, nombre, email, activo: u.ACTIVE !== false });
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
