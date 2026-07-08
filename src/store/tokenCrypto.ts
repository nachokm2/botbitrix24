import crypto from 'crypto';

// Cifrado de tokens OAuth en reposo (AES-256-GCM). La clave va en TOKEN_ENC_KEY (32 bytes en hex = 64 chars).
// Si no hay clave válida, se degrada a texto plano (compatibilidad) — así la migración es transparente:
// los valores ya guardados en claro se leen igual, y los nuevos se cifran en cuanto se define la clave.
const KEY_HEX = process.env.TOKEN_ENC_KEY ?? '';
const MARKER = 'enc:v1:';

function key(): Buffer | null {
  if (!KEY_HEX) return null;
  try {
    const b = Buffer.from(KEY_HEX, 'hex');
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}

/** Cifra un token para reposo. Si no hay clave válida o ya está cifrado, lo devuelve tal cual. */
export function encryptToken(plain?: string): string | undefined {
  if (plain == null || plain === '') return plain;
  if (plain.startsWith(MARKER)) return plain;
  const k = key();
  if (!k) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return MARKER + [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

/** Descifra un token. Si no está marcado como cifrado (o no hay clave), lo devuelve tal cual. */
export function decryptToken(stored?: string): string | undefined {
  if (stored == null || !stored.startsWith(MARKER)) return stored;
  const k = key();
  if (!k) return stored;
  try {
    const [ivB, tagB, ctB] = stored.slice(MARKER.length).split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(ivB, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64'));
    const pt = Buffer.concat([decipher.update(Buffer.from(ctB, 'base64')), decipher.final()]);
    return pt.toString('utf8');
  } catch {
    return stored;
  }
}
