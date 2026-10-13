import { getJson, setJson } from './store/kv';
import { encryptToken, decryptToken } from './store/tokenCrypto';

/** Credenciales OAuth de Bitrix24 (vienen con cada evento y en la instalación). */
export type Auth = {
  domain: string;
  access_token: string;
  refresh_token?: string;
  member_id?: string;
  expires?: number;
  /** Usuario de Bitrix dueño del token. Importa porque los eventos llegan con el token del usuario
   *  que los disparó: si un asesor escribe en el chat, viene el SUYO, y si ese asesor no tiene
   *  concedida la aplicación, el token no sirve para los métodos del bot. Ver setAuth. */
  user_id?: number;
};

type State = { auth?: Auth; botId?: number; appToken?: string; usuariosSinAcceso?: number[] };

// Estado del app (auth + botId + application_token) persistido en KV (Redis o memoria).
// Los tokens OAuth se cifran en reposo (ver tokenCrypto); el bot igual funciona con el auth
// que llega en cada evento, esto ayuda a /setup, scripts y refresh.
const KEY = 'app:state';

/** Lee el estado y DESCIFRA los tokens (uso interno + getState público). */
async function readState(): Promise<State> {
  const s = (await getJson<State>(KEY)) ?? {};
  if (s.auth) {
    s.auth = {
      ...s.auth,
      access_token: decryptToken(s.auth.access_token) ?? s.auth.access_token,
      refresh_token: decryptToken(s.auth.refresh_token),
    };
  }
  return s;
}

/** Escribe el estado CIFRANDO los tokens en reposo. */
async function writeState(s: State): Promise<void> {
  let toStore: State = s;
  if (s.auth) {
    toStore = {
      ...s,
      auth: {
        ...s.auth,
        access_token: encryptToken(s.auth.access_token) ?? s.auth.access_token,
        refresh_token: encryptToken(s.auth.refresh_token),
      },
    };
  }
  await setJson(KEY, toStore);
}

export function getState(): Promise<State> {
  return readState();
}

/** Auth vacío EXPLÍCITO para modo webhook-admin (callCrm ignora el auth cuando hay BITRIX_WEBHOOK_URL).
 *  Sustituye al antiguo `({} as any)`: mismo comportamiento, pero con tipo (sin agujeros de `any`). */
export const EMPTY_AUTH: Auth = { domain: '', access_token: '' };

/** Devuelve el auth persistido o null (para cortar con un error claro en vez de fabricar uno falso). */
export async function requireAuth(): Promise<Auth | null> {
  return (await readState()).auth ?? null;
}

/**
 * Guarda el token del app, descartando los que no sirven para sus métodos.
 *
 * Cada evento de Bitrix llega con el token del usuario que lo disparó. Cuando un asesor escribe en
 * un chat, ese token es SUYO — y si no tiene concedida la aplicación local, no sirve para
 * `imbot.message.add`. Guardarlo rompía todo lo proactivo: los recordatorios de seguimiento salían
 * con ese token y Bitrix los rechazaba con "user_access_error: The user does not have access to the
 * application", mientras las respuestas en vivo seguían funcionando porque usan el token del evento.
 *
 * Por eso se lleva una lista de usuarios cuyo token ya demostró no servir (ver marcarSinAcceso) y
 * sus tokens no se persisten. Se recupera solo: en cuanto llega un evento de un usuario que sí
 * tiene acceso, ese token queda guardado.
 */
export async function setAuth(auth: Auth): Promise<void> {
  const s = await readState();
  const sinAcceso = s.usuariosSinAcceso ?? [];
  if (auth.user_id && sinAcceso.includes(auth.user_id)) return; // ya sabemos que ese token no sirve
  s.auth = auth;
  await writeState(s);
}

/** Registra que el token de ese usuario no sirve para los métodos del app, y lo descarta si es el
 *  que estaba guardado — así el próximo evento de alguien con acceso lo reemplaza. */
export async function marcarSinAcceso(userId?: number): Promise<void> {
  if (!userId) return;
  const s = await readState();
  const sinAcceso = new Set(s.usuariosSinAcceso ?? []);
  if (sinAcceso.has(userId) && s.auth?.user_id !== userId) return;
  sinAcceso.add(userId);
  s.usuariosSinAcceso = [...sinAcceso].slice(-50); // acotado: no crece sin límite
  if (s.auth?.user_id === userId) s.auth = undefined;
  await writeState(s);
}

export async function setBotId(botId: number): Promise<void> {
  const s = await readState();
  s.botId = botId;
  await writeState(s);
}

/** Persiste el application_token capturado en la instalación (para verificar eventos posteriores). */
export async function setAppToken(appToken: string): Promise<void> {
  const s = await readState();
  s.appToken = appToken;
  await writeState(s);
}
