import { getJson, setJson } from './store/kv';

/** Credenciales OAuth de Bitrix24 (vienen con cada evento y en la instalación). */
export type Auth = {
  domain: string;
  access_token: string;
  refresh_token?: string;
  member_id?: string;
  expires?: number;
};

type State = { auth?: Auth; botId?: number };

// Estado del app (auth + botId) persistido en KV (Redis o memoria).
// El bot igual funciona con el auth que llega en cada evento; esto ayuda a
// los scripts/refresh y al registro manual del bot.
const KEY = 'app:state';

export async function getState(): Promise<State> {
  return (await getJson<State>(KEY)) ?? {};
}

export async function setAuth(auth: Auth): Promise<void> {
  const s = await getState();
  s.auth = auth;
  await setJson(KEY, s);
}

export async function setBotId(botId: number): Promise<void> {
  const s = await getState();
  s.botId = botId;
  await setJson(KEY, s);
}
