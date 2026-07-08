// Redacción de PII (email/teléfono) reutilizable para logs y auditoría.
// Enmascara los valores dentro de strings a cualquier profundidad, preservando la estructura
// (para no romper la analítica que agrega por campos no sensibles como score/tipo/programa).

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE_INTL_RE = /\+\d{8,15}\b/g; // E.164 con prefijo +
const PHONE_CL_RE = /\b(?:56)?9\d{8}\b/g; // móvil chileno sin +

export function redactPII(v: unknown): unknown {
  if (typeof v === 'string') {
    return v.replace(EMAIL_RE, '[email]').replace(PHONE_INTL_RE, '[tel]').replace(PHONE_CL_RE, '[tel]');
  }
  if (Array.isArray(v)) return v.map(redactPII);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, redactPII(x)]));
  }
  return v;
}
