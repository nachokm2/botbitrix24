import { config } from '../config';

// ── Registro de programas de campaña — NÚCLEO DE LA ESCALABILIDAD ──
// Toda la lógica específica de un programa (embudo, etapas, campos UF, asesores, asistente de voz,
// plantilla de WhatsApp, agenda de llamadas) vive AQUÍ como configuración. El orquestador, el scheduler
// y la máquina de estados leen ProgramConfig y NUNCA mencionan un programa concreto. Habilitar otro
// programa = agregar una entrada a PROGRAMAS (mismo patrón que los perfiles de canal en core/channel.ts:
// "un motor, N programas"). Los valores concretos salen de variables de entorno para no tocar el código.

export type CampaignAgenda = {
  tz: string; // 'America/Santiago'
  waves: string[]; // ['09:15','14:15','18:45']
  maxPorDia: number; // 3
  maxDias: number; // 3
  maxTotal: number; // 9
  ventanaHabil: [string, string]; // ['09:00','19:00']
  diasHabiles: number[]; // [1,2,3,4,5] (dom=0)
  feriados: string[]; // ['2026-09-18', ...] YYYY-MM-DD
};

export type ProgramConfig = {
  code: string;
  nombre: string;
  activo: boolean;
  bitrix: {
    categoryId: number; // embudo del programa
    filtroDeals: Record<string, unknown>; // filtro base de la cola de deals
    stageEnCampana: string; // STAGE_ID mientras está en campaña
    stageInteresado: string; // destino al escalar
    stageNoInteresado: string;
    stageRecuperacion: string;
    ufPrograma: string;
    ufScore: string;
    ufClasificacion: string;
    ufPrioridad: string;
    ufProxSeguimiento: string;
    ufIntentos: string;
  };
  asesor: { estrategia: 'round-robin' | 'owner' | 'fixed'; pool: number[]; fallbackUserId: number };
  voz: { vapiAssistantId: string; callerNumberId: string };
  whatsapp: { templateName: string; templateLang: string };
  agenda: CampaignAgenda;
};

// Helpers de parseo de entorno (mismo estilo que src/config.ts).
const csv = (s?: string): string[] => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const ints = (s?: string): number[] => csv(s).map(Number).filter((n) => Number.isFinite(n));
const num = (s: string | undefined, d: number): number => Number(s ?? '') || d;
function estrategia(s?: string): ProgramConfig['asesor']['estrategia'] {
  return s === 'owner' || s === 'fixed' ? s : 'round-robin';
}

/** Programa piloto: Magíster en Marketing Digital. Compone valores compartidos desde `config` (Vapi/UF
 *  ya existentes) y lee del entorno lo específico de la campaña. `activo` arranca en false por seguridad. */
const MMD: ProgramConfig = {
  code: 'MMD',
  nombre: 'Magíster en Marketing Digital',
  activo: (process.env.CAMPAIGN_MMD_ACTIVO ?? 'false') === 'true',
  bitrix: {
    categoryId: num(process.env.CAMPAIGN_MMD_CATEGORY_ID, 0),
    // El filtro de programa (UF = MMD) se añade en tiempo de query cuando ufPrograma está configurado.
    filtroDeals: { CLOSED: 'N' },
    stageEnCampana: process.env.CAMPAIGN_MMD_STAGE_EN_CAMPANA ?? '',
    stageInteresado: process.env.CAMPAIGN_MMD_STAGE_INTERESADO ?? config.voiceStageInteresado ?? '',
    stageNoInteresado: process.env.CAMPAIGN_MMD_STAGE_NO_INTERESADO ?? '',
    stageRecuperacion: process.env.CAMPAIGN_MMD_STAGE_RECUPERACION ?? '',
    ufPrograma: config.ufPrograma,
    ufScore: config.ufScore,
    ufClasificacion: process.env.BITRIX_UF_CLASIFICACION ?? '',
    ufPrioridad: process.env.BITRIX_UF_PRIORIDAD ?? '',
    ufProxSeguimiento: process.env.BITRIX_UF_PROX_SEGUIMIENTO ?? '',
    ufIntentos: process.env.BITRIX_UF_INTENTOS ?? '',
  },
  asesor: {
    estrategia: estrategia(process.env.CAMPAIGN_MMD_ASESOR_ESTRATEGIA),
    pool: ints(process.env.CAMPAIGN_MMD_ASESORES),
    fallbackUserId: num(process.env.CAMPAIGN_MMD_ASESOR_FALLBACK, config.voiceTaskUserId),
  },
  voz: { vapiAssistantId: config.vapiAssistantId, callerNumberId: config.vapiPhoneNumberId },
  whatsapp: {
    templateName: process.env.CAMPAIGN_MMD_WA_TEMPLATE ?? '',
    templateLang: process.env.CAMPAIGN_MMD_WA_LANG ?? 'es',
  },
  agenda: {
    tz: process.env.CAMPAIGN_TZ ?? 'America/Santiago',
    waves: csv(process.env.CAMPAIGN_WAVES).length ? csv(process.env.CAMPAIGN_WAVES) : ['09:15', '14:15', '18:45'],
    maxPorDia: num(process.env.CAMPAIGN_MAX_POR_DIA, 3),
    maxDias: num(process.env.CAMPAIGN_MAX_DIAS, 3),
    maxTotal: num(process.env.CAMPAIGN_MAX_TOTAL, 9),
    ventanaHabil: [process.env.CAMPAIGN_VENTANA_INI ?? '09:00', process.env.CAMPAIGN_VENTANA_FIN ?? '19:00'],
    diasHabiles: ints(process.env.CAMPAIGN_DIAS_HABILES).length ? ints(process.env.CAMPAIGN_DIAS_HABILES) : [1, 2, 3, 4, 5],
    feriados: csv(process.env.CAMPAIGN_FERIADOS),
  },
};

export const PROGRAMAS: Record<string, ProgramConfig> = { MMD };

/** Devuelve la config de un programa por código (o undefined si no existe). */
export function getProgram(code?: string): ProgramConfig | undefined {
  return code ? PROGRAMAS[code] : undefined;
}

/** Programas con la campaña activada (los que recorre el scheduler). */
export function activePrograms(): ProgramConfig[] {
  return Object.values(PROGRAMAS).filter((p) => p.activo);
}

/** Resuelve el programa por embudo (CATEGORY_ID del Deal) — útil para clasificar un Deal entrante. */
export function programByCategory(categoryId: number): ProgramConfig | undefined {
  return Object.values(PROGRAMAS).find((p) => p.bitrix.categoryId === categoryId);
}

/** Filtro de deals de la cola de campaña: base + programa (UF) cuando está configurado. */
export function filtroCola(p: ProgramConfig): Record<string, unknown> {
  const f: Record<string, unknown> = { CATEGORY_ID: p.bitrix.categoryId, ...p.bitrix.filtroDeals };
  if (p.bitrix.ufPrograma) f[p.bitrix.ufPrograma] = p.nombre;
  return f;
}
