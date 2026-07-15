import crypto from 'crypto';

/**
 * Comparación de secretos en tiempo constante (evita timing attacks). Antes vivía copiada en
 * bitrix/verifyEvent.ts, routes/guard.ts y routes/verifySecret.ts (ver ALT-Media-5 de la auditoría).
 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
