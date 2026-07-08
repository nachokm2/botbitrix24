import { getJson, setJson } from './store/kv';
import { encryptToken, decryptToken } from './store/tokenCrypto';

/** Credenciales OAuth de Bitrix24 (vienen con cada evento y en la instalación). */
export type Auth = {
  domain: string;
  access_token: string;
  refresh_token?: string;
  member_id?: string;
  expires?: number;
};

type State = { auth?: Auth; botId?: number; appToken?: string };

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

export async function setAuth(auth: Auth): Promise<void> {
  const s = await readState();
  s.auth = auth;
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
