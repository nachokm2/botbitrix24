import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Credenciales OAuth de Bitrix24 (vienen con cada evento y en la instalación). */
export type Auth = {
  domain: string;
  access_token: string;
  refresh_token?: string;
  member_id?: string;
  expires?: number;
};

type State = { auth?: Auth; botId?: number };

// Persistencia mínima para el PoC. En Railway el filesystem es efímero:
// no es problema porque el bot usa el `auth` que llega en cada evento.
// Este store solo facilita los scripts de smoke y el registro manual del bot.
const FILE = path.join(process.cwd(), '.data', 'state.json');
let cache: State | null = null;

async function read(): Promise<State> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(FILE, 'utf8')) as State;
  } catch {
    cache = {};
  }
  return cache;
}

async function write(s: State) {
  cache = s;
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(s, null, 2));
}

export async function getState(): Promise<State> {
  return read();
}

export async function setAuth(auth: Auth) {
  const s = await read();
  s.auth = auth;
  await write(s);
}

export async function setBotId(botId: number) {
  const s = await read();
  s.botId = botId;
  await write(s);
}
