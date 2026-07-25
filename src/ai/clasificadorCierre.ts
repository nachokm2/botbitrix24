import { anthropic, CLASSIFIER } from './client';
import { recordTokens } from '../obs/metrics';
import { log } from '../log';

// ── Fase 2: Clasificador de CIERRE de una llamada de campaña saliente ──
// Dos caminos:
//   1) DETERMINÍSTICO (gratis, sin IA): a partir del `endedReason` de Vapi resuelve los NO-CONTACTO
//      (no contesta / buzón / ocupado / número inválido / error técnico). Ver clasificarPorEndedReason.
//   2) IA (Haiku): cuando SÍ hubo conversación, clasifica la transcripción en las 8 categorías
//      + un leadScore 0-100 con 6 factores + objeciones/temas/resumen. Ver clasificarCierreIA.
// La prioridad y la "siguiente acción" se DERIVAN de forma determinística (derivarAccion), no se dejan
// al criterio del modelo. Sin I/O de CRM: el cableado a Bitrix/FSM es Fase 3.

export type CierreCategoria =
  | 'Muy interesado'
  | 'Interesado'
  | 'Requiere seguimiento'
  | 'Más adelante'
  | 'No interesado'
  | 'No contesta'
  | 'Número incorrecto'
  | 'No es el titular';

export type Factores = {
  interes: number;
  intencion: number;
  urgencia: number;
  presupuesto: number;
  disponibilidad: number;
  participacion: number;
};

export type SiguienteAccion = 'escalar' | 'callback' | 'nurture' | 'cerrar' | 'reintentar';

export type Cierre = {
  clasificacion: CierreCategoria;
  leadScore: number; // 0-100
  factores: Factores;
  objeciones: string[];
  temas: string[];
  resumen: string;
  prioridad: 'alta' | 'media' | 'baja';
  siguienteAccion: SiguienteAccion;
  /** Código técnico del resultado (para call_attempt.outcome_code y la FSM). */
  outcomeCode: 'answered' | 'no_answer' | 'voicemail' | 'busy' | 'invalid_number' | 'error';
};

const CATEGORIAS: CierreCategoria[] = [
  'Muy interesado', 'Interesado', 'Requiere seguimiento', 'Más adelante',
  'No interesado', 'No contesta', 'Número incorrecto', 'No es el titular',
];

const clamp = (n: unknown): number => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
const factor0: Factores = { interes: 0, intencion: 0, urgencia: 0, presupuesto: 0, disponibilidad: 0, participacion: 0 };

/** Deriva prioridad + siguiente acción a partir de la categoría y el score (determinístico). */
export function derivarAccion(
  clasificacion: CierreCategoria,
  leadScore: number,
  umbralEscalar = 70,
): { prioridad: Cierre['prioridad']; siguienteAccion: SiguienteAccion } {
  switch (clasificacion) {
    case 'Muy interesado':
      return { prioridad: 'alta', siguienteAccion: 'escalar' };
    case 'Interesado':
      return { prioridad: 'alta', siguienteAccion: 'escalar' };
    case 'Requiere seguimiento':
      return leadScore >= umbralEscalar
        ? { prioridad: 'alta', siguienteAccion: 'escalar' }
        : { prioridad: 'media', siguienteAccion: 'callback' };
    case 'Más adelante':
      return { prioridad: 'baja', siguienteAccion: 'nurture' };
    case 'No interesado':
      return { prioridad: 'baja', siguienteAccion: 'cerrar' };
    case 'No es el titular':
      return { prioridad: 'baja', siguienteAccion: 'reintentar' };
    case 'Número incorrecto':
      return { prioridad: 'baja', siguienteAccion: 'cerrar' };
    case 'No contesta':
    default:
      return { prioridad: 'baja', siguienteAccion: 'reintentar' };
  }
}

function noContacto(clasificacion: CierreCategoria, outcome: Cierre['outcomeCode']): Cierre {
  const resumen =
    outcome === 'invalid_number' ? 'Número inválido/incorrecto.'
    : outcome === 'voicemail' ? 'Cayó en buzón de voz.'
    : outcome === 'busy' ? 'Línea ocupada.'
    : outcome === 'error' ? 'Error técnico durante la llamada.'
    : 'No contestó la llamada.';
  return {
    clasificacion,
    leadScore: 0,
    factores: { ...factor0 },
    objeciones: [],
    temas: [],
    resumen,
    ...derivarAccion(clasificacion, 0),
    outcomeCode: outcome,
  };
}

/**
 * Resuelve el resultado a partir del `endedReason` de Vapi SIN llamar al modelo. Devuelve un Cierre
 * para los no-contacto; devuelve null cuando hubo conversación real (→ clasifica la IA por transcripción).
 */
export function clasificarPorEndedReason(endedReason?: string, _durationSec = 0): Cierre | null {
  const er = String(endedReason ?? '').toLowerCase();
  if (!er) return null;

  // Conversación real → que decida la IA por la transcripción.
  if (/customer-ended-call|assistant-ended-call|assistant-said-end-call|assistant-forwarded|ended-call/.test(er)) {
    return null;
  }
  // Número inválido (patrones específicos primero).
  if (/invalid|unallocated|not-in-service|number-not-valid|21211|21214|21217|13224/.test(er)) {
    return noContacto('Número incorrecto', 'invalid_number');
  }
  if (/voicemail/.test(er)) return noContacto('No contesta', 'voicemail');
  if (/busy/.test(er)) return noContacto('No contesta', 'busy');
  if (/did-not-answer|no-answer|did-not-pick|ring-?timeout|customer-did-not/.test(er)) {
    return noContacto('No contesta', 'no_answer');
  }
  // Errores técnicos (reintentables), sin categoría comercial.
  if (/error|pipeline|provider|websocket|failed|silence-timed-out/.test(er)) {
    return noContacto('No contesta', 'error');
  }
  return null; // desconocido → deja que el caller intente la IA o el fallback
}

export const CLASIFICADOR_CIERRE_SYSTEM = `Eres un analista de llamadas comerciales del Magíster en Marketing Digital (Universidad Autónoma de Chile). Recibes la TRANSCRIPCIÓN de una llamada SALIENTE en la que nuestra asistente contactó a un prospecto. Devuelve SOLO un JSON válido (sin markdown, sin texto extra) con esta forma exacta:
{"clasificacion":"Muy interesado|Interesado|Requiere seguimiento|Más adelante|No interesado|No es el titular","leadScore":<entero 0-100>,"factores":{"interes":0-100,"intencion":0-100,"urgencia":0-100,"presupuesto":0-100,"disponibilidad":0-100,"participacion":0-100},"objeciones":["<texto corto>"],"temas":["<texto corto>"],"resumen":"<2-3 frases, ejecutivo, para el asesor humano>"}
Reglas: el leadScore es un promedio ponderado de los factores (interés e intención pesan más); sé ESTRICTO, sin señales claras el score es bajo. "Muy interesado" = intención de matrícula o pide hablar con un asesor ya. "No es el titular" = contestó otra persona. "objeciones" y "temas" pueden ir vacíos. El resumen NUNCA inventa datos que no estén en la transcripción.`;

function categoriaValida(v: unknown): CierreCategoria {
  const s = String(v ?? '').trim();
  return (CATEGORIAS as string[]).includes(s) ? (s as CierreCategoria) : 'Requiere seguimiento';
}

function normFactores(f: any): Factores {
  return {
    interes: clamp(f?.interes),
    intencion: clamp(f?.intencion),
    urgencia: clamp(f?.urgencia),
    presupuesto: clamp(f?.presupuesto),
    disponibilidad: clamp(f?.disponibilidad),
    participacion: clamp(f?.participacion),
  };
}

const arr = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 10) : [];

/** Clasifica una conversación real por transcripción con Haiku. Devuelve null si no hay material o falla. */
export async function clasificarCierreIA(transcript: string, umbralEscalar = 70): Promise<Cierre | null> {
  const t = String(transcript ?? '').trim();
  if (t.length < 5) return null;
  try {
    const resp = await anthropic.messages.create({
      model: CLASSIFIER,
      max_tokens: 500,
      system: CLASIFICADOR_CIERRE_SYSTEM,
      messages: [{ role: 'user', content: `Transcripción:\n${t}\n\nDevuelve el JSON.` }],
    });
    recordTokens((resp as any).usage);
    const raw = (resp.content as any[]).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    const clasificacion = categoriaValida(json.clasificacion);
    const leadScore = clamp(json.leadScore);
    return {
      clasificacion,
      leadScore,
      factores: normFactores(json.factores),
      objeciones: arr(json.objeciones),
      temas: arr(json.temas),
      resumen: String(json.resumen ?? '').trim(),
      ...derivarAccion(clasificacion, leadScore, umbralEscalar),
      outcomeCode: 'answered',
    };
  } catch (e) {
    log.warn('clasificarCierreIA falló', { err: String(e) });
    return null;
  }
}

/**
 * Punto de entrada: clasifica el cierre de una llamada. Primero intenta el camino determinístico por
 * `endedReason`; si hubo conversación real y hay transcripción, usa la IA; si no, cae a "No contesta".
 */
export async function clasificarCierre(
  input: { endedReason?: string; durationSec?: number; transcript?: string },
  umbralEscalar = 70,
): Promise<Cierre> {
  const det = clasificarPorEndedReason(input.endedReason, input.durationSec);
  if (det) return det;
  const t = String(input.transcript ?? '').trim();
  if (t.length >= 5) {
    const ia = await clasificarCierreIA(t, umbralEscalar);
    if (ia) return ia;
  }
  return noContacto('No contesta', 'no_answer');
}
