import { callCrm, callCrmEnvelope } from '../bitrix/client';
import { getUsuarios } from './openlinesCrm';
import { log } from '../log';
import type { Auth } from '../store';

// Analítica de llamadas: lee la estadística de telefonía de Bitrix24 (voximplant.statistic.get),
// que reúne TODAS las llamadas entrantes/salientes del portal (de asesores humanos y del agente de voz,
// porque el bot las registra vía telephony.externalCall.*). Agrega KPIs + series por hora/día.
// Requiere que el webhook admin (BITRIX_WEBHOOK_URL) tenga el scope `telephony`.
// Doc: https://apidocs.bitrix24.com/api-reference/telephony/voximplant/voximplant-statistic-get.html

export type CallFilters = {
  from?: string; // 'YYYY-MM-DD'
  to?: string; // 'YYYY-MM-DD'
  userId?: number; // PORTAL_USER_ID
  type?: 'in' | 'out'; // entrante / saliente
  status?: 'answered' | 'missed'; // contestada / perdida
  phone?: string; // coincidencia parcial de número
  limit?: number; // máximo de llamadas a traer (cap de rendimiento)
};

export type CallRow = {
  id: string;
  fecha: string; // ISO original de Bitrix (hora del portal)
  tipo: 'entrante' | 'saliente' | 'callback' | 'otro';
  tipoCode: number;
  telefono: string;
  duracion: number; // segundos
  usuarioId: number;
  usuario: string;
  estado: string;
  estadoCode: string;
  contestada: boolean;
  grabacion: string | null;
  crmTipo?: string;
  crmId?: number;
  contacto: string | null;
};

const MAX_DEFAULT = 500; // cap de llamadas a traer por consulta (10 páginas de 50)
const MAX_HARD = 2000;

function isOutbound(t: number): boolean {
  return t === 1 || t === 4; // 1 saliente, 4 callback (saliente)
}
function tipoLabel(t: number): CallRow['tipo'] {
  if (t === 1) return 'saliente';
  if (t === 2 || t === 3) return 'entrante';
  if (t === 4) return 'callback';
  return 'otro';
}
function isAnswered(code: string): boolean {
  return String(code) === '200';
}
/** Traduce el CALL_FAILED_CODE (tipo SIP) a un estado legible. */
function estadoLabel(code: string): string {
  const map: Record<string, string> = {
    '200': 'Contestada',
    '304': 'No contestada',
    '486': 'Ocupado',
    '603': 'Rechazada',
    '403': 'Bloqueada',
    '404': 'Número inválido',
    '480': 'No disponible',
    '408': 'Sin respuesta',
    '487': 'Cancelada',
    '500': 'Error',
    '503': 'Servicio no disponible',
  };
  return map[String(code)] || `Código ${code}`;
}

/** Hora local del portal (0-23) tomada del string ISO, sin depender del huso del servidor. */
function horaDe(fecha: string): number {
  const m = /T(\d{2}):/.exec(fecha || '');
  if (m) return Number(m[1]);
  const d = new Date(fecha);
  return Number.isNaN(d.getTime()) ? 0 : d.getUTCHours();
}
/** Día de la semana (0=Dom..6=Sáb) de la fecha calendario, sin corrimiento por huso. */
function diaSemanaDe(fecha: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(fecha || '');
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
  const d = new Date(fecha);
  return Number.isNaN(d.getTime()) ? 0 : d.getUTCDay();
}

/** Construye el FILTER de voximplant.statistic.get desde los filtros de la UI. */
function buildFilter(f: CallFilters): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (f.from) filter['>=CALL_START_DATE'] = `${f.from}T00:00:00`;
  if (f.to) filter['<=CALL_START_DATE'] = `${f.to}T23:59:59`;
  if (f.userId) filter['PORTAL_USER_ID'] = f.userId;
  if (f.type === 'out') filter['@CALL_TYPE'] = [1, 4];
  if (f.type === 'in') filter['@CALL_TYPE'] = [2, 3];
  if (f.status === 'answered') filter['CALL_FAILED_CODE'] = '200';
  if (f.status === 'missed') filter['!CALL_FAILED_CODE'] = '200';
  if (f.phone) filter['%PHONE_NUMBER'] = f.phone;
  return filter;
}

/** Trae las llamadas crudas paginando voximplant.statistic.get (hasta `limit`). */
async function fetchCalls(f: CallFilters, auth: Auth): Promise<{ rows: any[]; total: number }> {
  const limit = Math.min(Math.max(Number(f.limit) || MAX_DEFAULT, 1), MAX_HARD);
  const filter = buildFilter(f);
  const rows: any[] = [];
  let start = 0;
  let total = 0;
  for (let page = 0; page < Math.ceil(limit / 50) + 1; page++) {
    const env = await callCrmEnvelope<any[]>(
      'voximplant.statistic.get',
      { FILTER: filter, SORT: 'CALL_START_DATE', ORDER: 'DESC', start },
      auth,
    );
    const batch = Array.isArray(env.result) ? env.result : [];
    total = env.total ?? total;
    rows.push(...batch);
    if (rows.length >= limit || env.next == null || batch.length === 0) break;
    start = env.next;
  }
  return { rows: rows.slice(0, limit), total: total || rows.length };
}

/** Resuelve nombres de contactos/empresas/leads por ID (en lotes de 50), best-effort. */
async function resolveEntidades(pairs: { tipo: string; id: number }[], auth: Auth): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const porTipo: Record<string, number[]> = { CONTACT: [], COMPANY: [], LEAD: [] };
  for (const p of pairs) {
    const t = String(p.tipo || '').toUpperCase();
    if (porTipo[t] && p.id && !porTipo[t].includes(p.id)) porTipo[t].push(p.id);
  }
  const chunk = (a: number[], n: number) => a.reduce<number[][]>((r, _, i) => (i % n ? r : [...r, a.slice(i, i + n)]), []);
  const MAXU = 300; // cap de entidades a resolver por consulta (rendimiento)

  const jobs: Promise<void>[] = [];
  const run = (tipo: string, method: string, select: string[], name: (r: any) => string) => {
    const ids = porTipo[tipo].slice(0, MAXU);
    for (const ids50 of chunk(ids, 50)) {
      jobs.push(
        callCrm(method, { filter: { '@ID': ids50 }, select: ['ID', ...select] }, auth)
          .then((res: any) => {
            const list = Array.isArray(res) ? res : (res?.items ?? []);
            for (const r of list) out.set(`${tipo}:${r.ID}`, name(r));
          })
          .catch((e) => log.warn(`resolveEntidades ${tipo} falló`, { err: String(e) })),
      );
    }
  };
  const full = (r: any) => [r.NAME, r.LAST_NAME].filter(Boolean).join(' ').trim() || r.COMPANY_TITLE || '';
  if (porTipo.CONTACT.length) run('CONTACT', 'crm.contact.list', ['NAME', 'LAST_NAME', 'COMPANY_TITLE'], full);
  if (porTipo.COMPANY.length) run('COMPANY', 'crm.company.list', ['TITLE'], (r) => r.TITLE || '');
  if (porTipo.LEAD.length) run('LEAD', 'crm.lead.list', ['TITLE', 'NAME', 'LAST_NAME'], (r) => r.TITLE || full(r));
  await Promise.all(jobs);
  return out;
}

export type CallAnalytics = {
  fetched: number;
  total: number;
  kpis: {
    total: number;
    entrantes: number;
    salientes: number;
    contestadas: number;
    perdidas: number;
    durTotal: number;
    durProm: number;
    tasaContestadas: number;
    tasaPerdidas: number;
  };
  porHora: { h: number; entrantes: number; salientes: number }[];
  porDia: { d: number; entrantes: number; salientes: number }[];
  usuarios: { id: number; nombre: string }[]; // para el filtro de asesores
  rows: CallRow[];
};

/** Orquesta: trae llamadas, resuelve nombres, agrega KPIs y series. */
export async function getCallAnalytics(f: CallFilters, auth: Auth): Promise<CallAnalytics> {
  const { rows: raw, total } = await fetchCalls(f, auth);

  // Nombres de asesores (todos los IDs presentes) y de entidades CRM (para la tabla).
  const userIds = Array.from(new Set(raw.map((r) => Number(r.PORTAL_USER_ID)).filter((n) => n > 0)));
  const entPairs = raw
    .filter((r) => r.CRM_ENTITY_TYPE && r.CRM_ENTITY_ID)
    .map((r) => ({ tipo: String(r.CRM_ENTITY_TYPE), id: Number(r.CRM_ENTITY_ID) }));

  const [usuarios, entidades] = await Promise.all([
    userIds.length ? getUsuarios(userIds, auth) : Promise.resolve([]),
    entPairs.length ? resolveEntidades(entPairs, auth) : Promise.resolve(new Map<string, string>()),
  ]);
  const userById = new Map(usuarios.map((u) => [u.id, u.nombre]));

  // KPIs + series por hora (0-23) y día (0-6).
  const porHora = Array.from({ length: 24 }, (_, h) => ({ h, entrantes: 0, salientes: 0 }));
  const porDia = Array.from({ length: 7 }, (_, d) => ({ d, entrantes: 0, salientes: 0 }));
  let entrantes = 0,
    salientes = 0,
    contestadas = 0,
    durTotal = 0;

  const rows: CallRow[] = raw.map((r) => {
    const t = Number(r.CALL_TYPE);
    const out = isOutbound(t);
    const dur = Number(r.CALL_DURATION) || 0;
    const code = String(r.CALL_FAILED_CODE ?? '');
    const answered = isAnswered(code);
    const h = horaDe(r.CALL_START_DATE);
    const d = diaSemanaDe(r.CALL_START_DATE);

    if (out) {
      salientes++;
      porHora[h].salientes++;
      porDia[d].salientes++;
    } else {
      entrantes++;
      porHora[h].entrantes++;
      porDia[d].entrantes++;
    }
    if (answered) {
      contestadas++;
      durTotal += dur;
    }

    const uid = Number(r.PORTAL_USER_ID) || 0;
    const crmTipo = r.CRM_ENTITY_TYPE ? String(r.CRM_ENTITY_TYPE) : undefined;
    const crmId = r.CRM_ENTITY_ID ? Number(r.CRM_ENTITY_ID) : undefined;
    const contacto = crmTipo && crmId ? entidades.get(`${crmTipo.toUpperCase()}:${crmId}`) || null : null;

    return {
      id: String(r.ID),
      fecha: String(r.CALL_START_DATE ?? ''),
      tipo: tipoLabel(t),
      tipoCode: t,
      telefono: String(r.PHONE_NUMBER ?? ''),
      duracion: dur,
      usuarioId: uid,
      usuario: userById.get(uid) || (uid ? `Usuario ${uid}` : '—'),
      estado: estadoLabel(code),
      estadoCode: code,
      contestada: answered,
      grabacion: r.CALL_RECORD_URL ? String(r.CALL_RECORD_URL) : null,
      crmTipo,
      crmId,
      contacto,
    };
  });

  const totalC = rows.length;
  const perdidas = totalC - contestadas;
  const kpis = {
    total: totalC,
    entrantes,
    salientes,
    contestadas,
    perdidas,
    durTotal,
    durProm: contestadas > 0 ? Math.round(durTotal / contestadas) : 0,
    tasaContestadas: totalC > 0 ? Math.round((contestadas / totalC) * 100) : 0,
    tasaPerdidas: totalC > 0 ? Math.round((perdidas / totalC) * 100) : 0,
  };

  return {
    fetched: totalC,
    total,
    kpis,
    porHora,
    porDia,
    usuarios: usuarios.map((u) => ({ id: u.id, nombre: u.nombre })),
    rows,
  };
}
