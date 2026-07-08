import { redactPII } from './obs/redact';
import { getRequestContext } from './obs/requestContext';

type Meta = Record<string, unknown>;

// Redacción de PII (email/teléfono) para no volcar datos personales a stdout (Railway).
// Desactivable con LOG_REDACT=off para depuración local.
const REDACT = process.env.LOG_REDACT !== 'off';

function emit(level: string, msg: string, meta?: Meta) {
  // Correlación: adjunta reqId (y dialogId, si aplica) del contexto de la petición.
  const ctx = getRequestContext();
  const merged: Meta = {};
  if (ctx) {
    merged.reqId = ctx.requestId;
    if (ctx.dialogId) merged.dialogId = ctx.dialogId;
  }
  Object.assign(merged, meta ?? {});
  const safe = REDACT ? (redactPII(merged) as Meta) : merged;
  const extra = Object.keys(safe).length ? ' ' + JSON.stringify(safe) : '';
  // Una sola línea de texto plano: Railway la muestra completa (no colapsa metadata).
  console.log(`${level.toUpperCase()} ${msg}${extra}`);
}

export const log = {
  info: (m: string, meta?: Meta) => emit('info', m, meta),
  warn: (m: string, meta?: Meta) => emit('warn', m, meta),
  error: (m: string, meta?: Meta) => emit('error', m, meta),
};
