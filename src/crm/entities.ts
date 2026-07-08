// Entidades CRM vinculadas a un chat de Open Lines: tipos + parsers PUROS de CHAT_ENTITY_DATA_2.
// Sin dependencias externas → testeable en aislamiento.
// Fuente de verdad: el evento ONIMBOTMESSAGEADD trae la vinculación en CHAT_ENTITY_DATA_2
// (ej. "LEAD|1209|COMPANY|0|CONTACT|0|DEAL|0").

export type CrmEntity = { type: 'lead' | 'deal' | 'contact' | 'company'; id: number };

/** Todas las entidades CRM vinculadas al chat (puede haber deal + contacto a la vez). */
export type CrmEntities = { lead?: number; contact?: number; deal?: number; company?: number };

const ETID: Record<string, number> = { lead: 1, deal: 2, contact: 3, company: 4 };
// Prioridad de relevancia comercial cuando hay varias entidades vinculadas.
const PRIORITY: CrmEntity['type'][] = ['deal', 'contact', 'lead', 'company'];

/** Parsea "LEAD|1209|COMPANY|0|CONTACT|0|DEAL|0" → la entidad más relevante con id > 0. */
export function parseEntityData2(data2?: string): CrmEntity | null {
  if (!data2 || typeof data2 !== 'string') return null;
  const parts = data2.split('|');
  const found: Partial<Record<CrmEntity['type'], number>> = {};
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const t = (parts[i] || '').toLowerCase();
    const id = Number(parts[i + 1]);
    if (id > 0 && ETID[t]) found[t as CrmEntity['type']] = id;
  }
  for (const t of PRIORITY) if (found[t]) return { type: t, id: found[t]! };
  return null;
}

export function parseAllEntities(data2?: string): CrmEntities {
  const out: CrmEntities = {};
  if (!data2 || typeof data2 !== 'string') return out;
  const parts = data2.split('|');
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const t = (parts[i] || '').toLowerCase() as keyof CrmEntities;
    const id = Number(parts[i + 1]);
    if (id > 0 && (t === 'lead' || t === 'contact' || t === 'deal' || t === 'company')) out[t] = id;
  }
  return out;
}

export function primaryEntity(e: CrmEntities): CrmEntity | null {
  for (const t of PRIORITY) if (e[t]) return { type: t, id: e[t]! };
  return null;
}
