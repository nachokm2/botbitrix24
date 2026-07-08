import { callCrm, callCrmEnvelope } from '../bitrix/client';
import { getUsuarios } from './openlinesCrm';
import { dbCallAnalytics } from '../store/db';
import { log } from '../log';
import type { Auth } from '../store';
import type { VoximplantCall, BitrixCrmListItem, BitrixCrmListResponse } from '../bitrix/types';

// Analítica de llamadas: lee la estadística de telefonía de Bitrix24 (voximplant.statistic.get),
// que reúne TODAS las llamadas entrantes/salientes del portal (asesores humanos y agente de voz,
// porque el bot las registra vía telephony.externalCall.*).
// Hay dos caminos: EN VIVO (REST, muestra acotada) y POSTGRES (KPIs exactos del período, si hay DATABASE_URL).
// Requiere que el webhook admin (BITRIX_WEBHOOK_URL) tenga el scope `telephony`.
// Doc: https://apidocs.bitrix24.com/api-reference/telephony/voximplant/voximplant-statistic-get.html

export type CallFilters = {
  from?: string; // 'YYYY-MM-DD'
  to?: string; // 'YYYY-MM-DD'
  userId?: number; // PORTAL_USER_ID
  type?: 'in' | 'out'; // entrante / saliente
  status?: 'answered' | 'missed'; // contestada / perdida
  phone?: string; // coincidencia parcial de número
  limit?: number; // (solo camino EN VIVO) máximo de llamadas a traer
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

/** Registro normalizado (sin nombres); base común para agregación, tabla y persistencia en Postgres. */
export type NormCall = {
  id: string;
  iso: string;
  localDate: string; // 'YYYY-MM-DD' (día del portal)
  hora: number; // 0-23 (hora del portal)
  dow: number; // 0=Dom..6=Sáb
  tipoCode: number;
  isOutbound: boolean;
  telefono: string;
  duracion: number;
  usuarioId: number;
  estadoCode: string;
  contestada: boolean;
  grabacion: string | null;
  crmTipo?: string;
  crmId?: number;
};

const MAX_DEFAULT = 500;
const MAX_HARD = 2000;

function isOutbound(t: number): boolean {
  return t === 1 || t === 4; // 1 saliente, 4 callback (saliente)
}
export function tipoLabel(t: number): CallRow['tipo'] {
  if (t === 1) return 'saliente';
  if (t === 2 || t === 3) return 'entrante';
  if (t === 4) return 'callback';
  return 'otro';
}
/** El proveedor puede anexar sufijo al CALL_FAILED_CODE (ej. "603-S"); tomamos el código base numérico. */
function baseCode(code: string): string {
  return String(code ?? '').split('-')[0].trim();
}
function isAnswered(code: string): boolean {
  return baseCode(code) === '200';
}
export function estadoLabel(code: string): string {
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
  return map[baseCode(code)] || `Código ${code}`;
}
function horaDe(fecha: string): number {
  const m = /T(\d{2}):/.exec(fecha || '');
  if (m) return Number(m[1]);
  const d = new Date(fecha);
  return Number.isNaN(d.getTime()) ? 0 : d.getUTCHours();
}
function diaSemanaDe(fecha: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(fecha || '');
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
  const d = new Date(fecha);
  return Number.isNaN(d.getTime()) ? 0 : d.getUTCDay();
}

/** Normaliza una fila cruda de voximplant.statistic.get. */
export function normalizeCall(r: VoximplantCall): NormCall {
  const iso = String(r.CALL_START_DATE ?? '');
  const code = String(r.CALL_FAILED_CODE ?? '');
  return {
    id: String(r.ID),
    iso,
    localDate: (/^(\d{4}-\d{2}-\d{2})/.exec(iso)?.[1]) || iso.slice(0, 10),
    hora: horaDe(iso),
    dow: diaSemanaDe(iso),
    tipoCode: Number(r.CALL_TYPE),
    isOutbound: isOutbound(Number(r.CALL_TYPE)),
    telefono: String(r.PHONE_NUMBER ?? ''),
    duracion: Number(r.CALL_DURATION) || 0,
    usuarioId: Number(r.PORTAL_USER_ID) || 0,
    estadoCode: code,
    contestada: isAnswered(code),
    grabacion: r.CALL_RECORD_URL ? String(r.CALL_RECORD_URL) : null,
    crmTipo: r.CRM_ENTITY_TYPE ? String(r.CRM_ENTITY_TYPE) : undefined,
    crmId: r.CRM_ENTITY_ID ? Number(r.CRM_ENTITY_ID) : undefined,
  };
}

/** Resuelve nombres de contactos/empresas/leads por ID (en lotes de 50), best-effort. */
export async function resolveEntidades(pairs: { tipo: string; id: number }[], auth: Auth): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const porTipo: Record<string, number[]> = { CONTACT: [], COMPANY: [], LEAD: [] };
  for (const p of pairs) {
    const t = String(p.tipo || '').toUpperCase();
    if (porTipo[t] && p.id && !porTipo[t].includes(p.id)) porTipo[t].push(p.id);
  }
  const chunk = (a: number[], n: number) => a.reduce<number[][]>((r, _, i) => (i % n ? r : [...r, a.slice(i, i + n)]), []);
  const MAXU = 300;
  const jobs: Promise<void>[] = [];
  const run = (tipo: string, method: string, select: string[], name: (r: BitrixCrmListItem) => string) => {
    for (const ids50 of chunk(porTipo[tipo].slice(0, MAXU), 50)) {
      jobs.push(
        callCrm<BitrixCrmListResponse>(method, { filter: { '@ID': ids50 }, select: ['ID', ...select] }, auth)
          .then((res) => {
            const list: BitrixCrmListItem[] = Array.isArray(res) ? res : (res?.items ?? []);
            for (const r of list) out.set(`${tipo}:${r.ID}`, name(r));
          })
          .catch((e) => log.warn(`resolveEntidades ${tipo} falló`, { err: String(e) })),
      );
    }
  };
  const full = (r: BitrixCrmListItem) => [r.NAME, r.LAST_NAME].filter(Boolean).join(' ').trim() || r.COMPANY_TITLE || '';
  if (porTipo.CONTACT.length) run('CONTACT', 'crm.contact.list', ['NAME', 'LAST_NAME', 'COMPANY_TITLE'], full);
  if (porTipo.COMPANY.length) run('COMPANY', 'crm.company.list', ['TITLE'], (r) => r.TITLE || '');
  if (porTipo.LEAD.length) run('LEAD', 'crm.lead.list', ['TITLE', 'NAME', 'LAST_NAME'], (r) => r.TITLE || full(r));
  await Promise.all(jobs);
  return out;
}

/** Convierte NormCall[] a CallRow[] resolviendo nombres de asesor y de contacto/empresa/lead. */
async function toRowsConNombres(norm: NormCall[], auth: Auth): Promise<{ rows: CallRow[]; usuarios: { id: number; nombre: string }[] }> {
  const userIds = Array.from(new Set(norm.map((n) => n.usuarioId).filter((n) => n > 0)));
  const entPairs = norm.filter((n) => n.crmTipo && n.crmId).map((n) => ({ tipo: n.crmTipo!, id: n.crmId! }));
  const [usuarios, entidades] = await Promise.all([
    userIds.length ? getUsuarios(userIds, auth) : Promise.resolve([]),
    entPairs.length ? resolveEntidades(entPairs, auth) : Promise.resolve(new Map<string, string>()),
  ]);
  const userById = new Map(usuarios.map((u) => [u.id, u.nombre]));
  const rows: CallRow[] = norm.map((n) => ({
    id: n.id,
    fecha: n.iso,
    tipo: tipoLabel(n.tipoCode),
    tipoCode: n.tipoCode,
    telefono: n.telefono,
    duracion: n.duracion,
    usuarioId: n.usuarioId,
    usuario: userById.get(n.usuarioId) || (n.usuarioId ? `Usuario ${n.usuarioId}` : '—'),
    estado: estadoLabel(n.estadoCode),
    estadoCode: n.estadoCode,
    contestada: n.contestada,
    grabacion: n.grabacion,
    crmTipo: n.crmTipo,
    crmId: n.crmId,
    contacto: n.crmTipo && n.crmId ? entidades.get(`${n.crmTipo.toUpperCase()}:${n.crmId}`) || null : null,
  }));
  return { rows, usuarios: usuarios.map((u) => ({ id: u.id, nombre: u.nombre })) };
}

export type CallKpis = {
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
export type CallAnalytics = {
  mode: 'db' | 'live';
  fetched: number;
  total: number;
  kpis: CallKpis;
  porHora: { h: number; entrantes: number; salientes: number }[];
  porDia: { d: number; entrantes: number; salientes: number }[];
  usuarios: { id: number; nombre: string }[];
  rows: CallRow[];
};

function kpisFromNorm(norm: NormCall[]): CallKpis {
  let entrantes = 0, salientes = 0, contestadas = 0, durTotal = 0;
  for (const n of norm) {
    if (n.isOutbound) salientes++;
    else entrantes++;
    if (n.contestada) {
      contestadas++;
      durTotal += n.duracion;
    }
  }
  const total = norm.length;
  const perdidas = total - contestadas;
  return {
    total, entrantes, salientes, contestadas, perdidas, durTotal,
    durProm: contestadas > 0 ? Math.round(durTotal / contestadas) : 0,
    tasaContestadas: total > 0 ? Math.round((contestadas / total) * 100) : 0,
    tasaPerdidas: total > 0 ? Math.round((perdidas / total) * 100) : 0,
  };
}

// ─────────────────────────── Camino EN VIVO (REST, muestra acotada) ───────────────────────────

function buildFilter(f: CallFilters): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (f.from) filter['>=CALL_START_DATE'] = `${f.from}T00:00:00`;
  if (f.to) filter['<=CALL_START_DATE'] = `${f.to}T23:59:59`;
  if (f.userId) filter['PORTAL_USER_ID'] = f.userId;
  if (f.type === 'out') filter['@CALL_TYPE'] = [1, 4];
  if (f.type === 'in') filter['@CALL_TYPE'] = [2, 3];
  if (f.phone) filter['%PHONE_NUMBER'] = f.phone;
  return filter;
}

async function fetchCalls(f: CallFilters, auth: Auth): Promise<{ rows: VoximplantCall[]; total: number }> {
  const limit = Math.min(Math.max(Number(f.limit) || MAX_DEFAULT, 1), MAX_HARD);
  const filter = buildFilter(f);
  const rows: VoximplantCall[] = [];
  let start = 0;
  let total = 0;
  for (let page = 0; page < Math.ceil(limit / 50) + 1; page++) {
    const env = await callCrmEnvelope<VoximplantCall[]>(
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

/** KPIs + tabla sobre una MUESTRA reciente traída por REST (fallback cuando no hay Postgres). */
export async function getCallAnalytics(f: CallFilters, auth: Auth): Promise<CallAnalytics> {
  const { rows: fetched, total } = await fetchCalls(f, auth);
  let norm = fetched.map(normalizeCall);
  if (f.status === 'answered') norm = norm.filter((n) => n.contestada);
  else if (f.status === 'missed') norm = norm.filter((n) => !n.contestada);

  const porHora = Array.from({ length: 24 }, (_, h) => ({ h, entrantes: 0, salientes: 0 }));
  const porDia = Array.from({ length: 7 }, (_, d) => ({ d, entrantes: 0, salientes: 0 }));
  for (const n of norm) {
    (n.isOutbound ? (porHora[n.hora].salientes++, porDia[n.dow].salientes++) : (porHora[n.hora].entrantes++, porDia[n.dow].entrantes++));
  }
  const { rows, usuarios } = await toRowsConNombres(norm, auth);
  return { mode: 'live', fetched: norm.length, total, kpis: kpisFromNorm(norm), porHora, porDia, usuarios, rows };
}

// ─────────────────────────── Camino POSTGRES (KPIs exactos del período) ───────────────────────────

/** KPIs exactos (SQL) sobre TODO el rango + tabla (últimas N filas con nombres resueltos). */
export async function getCallAnalyticsFromDb(f: CallFilters, auth: Auth): Promise<CallAnalytics> {
  const d = await dbCallAnalytics(f); // { kpis, porHora, porDia, rowsNorm, total }
  const { rows, usuarios: usuariosPagina } = await toRowsConNombres(d.rowsNorm, auth);
  // Para el selector de asesores, usa el catálogo de IDs distintos del rango (no solo la página).
  let usuarios = usuariosPagina;
  if (d.userIds?.length) {
    try {
      const us = await getUsuarios(d.userIds, auth);
      usuarios = us.map((u) => ({ id: u.id, nombre: u.nombre }));
    } catch {
      /* deja los de la página */
    }
  }
  return { mode: 'db', fetched: rows.length, total: d.total, kpis: d.kpis, porHora: d.porHora, porDia: d.porDia, usuarios, rows };
}
