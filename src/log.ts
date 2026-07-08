type Meta = Record<string, unknown>;

// Redacción de PII en logs (email/teléfono): evita volcar datos personales a stdout (Railway).
// Desactivable con LOG_REDACT=off para depuración local.
const REDACT = process.env.LOG_REDACT !== 'off';
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE_INTL_RE = /\+\d{8,15}\b/g; // E.164 con prefijo +
const PHONE_CL_RE = /\b(?:56)?9\d{8}\b/g; // móvil chileno sin +

function redact(v: unknown): unknown {
  if (!REDACT) return v;
  if (typeof v === 'string') {
    return v.replace(EMAIL_RE, '[email]').replace(PHONE_INTL_RE, '[tel]').replace(PHONE_CL_RE, '[tel]');
  }
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, redact(x)]));
  }
  return v;
}

function emit(level: string, msg: string, meta?: Meta) {
  const safe = meta ? (redact(meta) as Meta) : undefined;
  const extra = safe && Object.keys(safe).length ? ' ' + JSON.stringify(safe) : '';
  // Una sola línea de texto plano: Railway la muestra completa (no colapsa metadata).
  console.log(`${level.toUpperCase()} ${msg}${extra}`);
}

export const log = {
  info: (m: string, meta?: Meta) => emit('info', m, meta),
  warn: (m: string, meta?: Meta) => emit('warn', m, meta),
  error: (m: string, meta?: Meta) => emit('error', m, meta),
};
