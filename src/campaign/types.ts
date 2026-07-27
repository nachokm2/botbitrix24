// Tipos del plano de control de la campaña de VOZ SALIENTE. Sin dependencias → testeable en aislamiento
// y reutilizable por el scheduler/FSM (Fase 3-4) y por la capa de datos (store/db.ts).

/** Estados de un Deal dentro de la campaña (columna campaign_target.status). Ver la máquina de estados
 *  del documento de arquitectura (§4). Los terminales cierran el ciclo del prospecto en la campaña. */
export type CampaignStatus =
  | 'PENDING' // en cola, esperando la próxima ola
  | 'LLAMANDO' // llamada disparada, en curso
  | 'EN_CONVERSACION' // contestó y conversa
  | 'CALIFICADO' // interés suficiente detectado
  | 'ESCALADO' // derivado a asesor humano (terminal)
  | 'SEGUIMIENTO' // requiere seguimiento / más adelante (sale a nurture)
  | 'CALLBACK' // pidió que lo llamen a otra hora
  | 'NO_TITULAR' // contestó otra persona
  | 'SIN_RESPUESTA' // no contesta / buzón / ocupado / rechazo
  | 'NO_INTERESADO' // rechazo explícito (terminal)
  | 'NUMERO_INVALIDO' // número inválido (terminal, saneo)
  | 'AGOTADO' // 9 intentos sin contacto
  | 'RECUPERACION'; // plantilla WhatsApp enviada (terminal de campaña)

/** Estado de campaña por Deal (una fila en campaign_target). */
export type CampaignTarget = {
  dealId: number;
  programCode: string;
  contactId?: number | null;
  phoneE164?: string | null;
  status: CampaignStatus;
  dayIndex: number; // 1..maxDias
  attemptsTotal: number; // 0..maxTotal
  attemptsToday: number; // 0..maxPorDia
  todayDate?: string | null; // YYYY-MM-DD (para resetear attemptsToday por día)
  lastWave?: string | null; // 'W1'|'W2'|'W3'
  lastAttemptAt?: string | null;
  nextAttemptAt?: string | null; // null = disponible en la próxima ola
  answeredAt?: string | null; // si != null, no se llama más
  lastOutcome?: string | null;
  classification?: string | null; // una de las 8 categorías de cierre
  leadScore?: number | null; // 0..100
  priority?: string | null; // alta|media|baja
  asesorId?: number | null;
  optedOut: boolean;
  whatsappSent: boolean;
};

/** Un intento de llamada (una fila en call_attempt) — auditoría fina + reportería. */
export type CallAttempt = {
  id?: number;
  dealId: number;
  programCode: string;
  attemptNo: number; // 1..maxTotal
  waveSlot?: string | null; // 'W1'|'W2'|'W3'
  scheduledAt?: string | null;
  vapiCallId?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  endedReason?: string | null; // endedReason de Vapi
  durationSec?: number | null;
  answered?: boolean | null;
  outcomeCode?: string | null;
  classification?: string | null;
  leadScore?: number | null;
  factores?: unknown; // {interes,intencion,urgencia,presupuesto,disponibilidad,participacion}
  objeciones?: unknown; // string[]
  temas?: unknown; // string[]
  resumen?: string | null;
  recordingUrl?: string | null;
  transcriptRef?: string | null;
};
