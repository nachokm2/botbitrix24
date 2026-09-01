import { callBitrix, callBitrixEnvelope } from '../bitrix/client';
import { log } from '../log';
import type { Auth } from '../store';

// Media entrante (audio/imagen/archivo) que el cliente manda por WhatsApp (Open Lines de Bitrix).
// Bitrix ADJUNTA el archivo en el evento ONIMBOTMESSAGEADD bajo params.FILES (objeto keyed por id),
// con type/extension/name y las URLs de descarga (urlDownload/urlShow). NO usamos disk.file.get: para
// los archivos del chat devuelve ACCESS_DENIED incluso con el webhook admin. En cambio bajamos la
// urlDownload del portal autenticada con el token OAuth del bot (que es participante del chat).

export type IncomingKind = 'image' | 'audio' | 'file';
export type IncomingMedia = {
  kind: IncomingKind;
  mediaType: string; // MIME (image/jpeg, audio/mpeg, ...)
  base64: string;
  name: string;
  bytes: number;
};

const MAX_BYTES = 12 * 1024 * 1024; // 12MB por archivo
const MAX_FILES = 5;

type BxFile = { id: number; type?: string; name: string; extension?: string; urlDownload?: string; urlShow?: string };

/** Normaliza params.FILES (objeto keyed por id, o array) a una lista de archivos con sus URLs. */
function collectFiles(params: any): BxFile[] {
  const files = params?.FILES ?? params?.files;
  const list: any[] = Array.isArray(files) ? files : files && typeof files === 'object' ? Object.values(files) : [];
  const out: BxFile[] = [];
  for (const f of list) {
    if (!f || typeof f !== 'object') continue;
    const id = Number(f.id ?? f.ID);
    if (!Number.isFinite(id) || id <= 0) continue;
    out.push({
      id,
      type: (String(f.type ?? f.TYPE ?? '').toLowerCase() || undefined),
      name: String(f.name ?? f.NAME ?? `file-${id}`),
      extension: (String(f.extension ?? '').toLowerCase() || undefined),
      urlDownload: f.urlDownload ?? f.urlShow,
      urlShow: f.urlShow,
    });
  }
  return out;
}

const IMG_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
const AUD_EXT = ['ogg', 'oga', 'opus', 'mp3', 'mpeg', 'm4a', 'wav', 'amr', 'aac', 'weba', 'webm', '3gp', '3gpp'];

function extOf(f: BxFile): string {
  return f.extension ?? (f.name.split('.').pop() ?? '').toLowerCase();
}

function kindOf(f: BxFile): IncomingKind {
  const t = f.type ?? '';
  const ext = extOf(f);
  if (t === 'image' || IMG_EXT.includes(ext)) return 'image';
  if (t === 'audio' || t === 'video' || AUD_EXT.includes(ext)) return 'audio';
  return 'file';
}

const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  mp3: 'audio/mpeg', mpeg: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  m4a: 'audio/mp4', wav: 'audio/wav', amr: 'audio/amr', aac: 'audio/aac', weba: 'audio/webm', webm: 'audio/webm',
};

function mimeOf(f: BxFile, kind: IncomingKind): string {
  return MIME[extOf(f)] ?? (kind === 'image' ? 'image/jpeg' : 'audio/ogg');
}

/** Agrega el token OAuth a una URL del portal. */
function authUrl(url: string, auth: Auth): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}auth=${encodeURIComponent(auth.access_token)}`;
}

/** Baja una URL y valida que sea un binario (no una página HTML de login). */
async function fetchBinary(url: string, tag: string, id: number): Promise<Buffer | null> {
  try {
    const r = await fetch(url);
    const ct = (r.headers.get('content-type') ?? '').toLowerCase();
    if (!r.ok) {
      log.warn(`media: ${tag} fetch no-ok`, { id, status: r.status, ct });
      return null;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (ct.includes('text/html')) {
      log.warn(`media: ${tag} devolvió HTML (no autenticó)`, { id, bytes: buf.length });
      return null;
    }
    if (buf.length > MAX_BYTES) {
      log.warn(`media: ${tag} archivo muy grande`, { id, bytes: buf.length });
      return null;
    }
    return buf;
  } catch (e) {
    log.warn(`media: ${tag} excepción`, { id, err: String(e) });
    return null;
  }
}

/** Obtiene los bytes de un archivo de chat probando varias estrategias. En producción se confirmó
 *  que disk.file.get (ACCESS_DENIED), im.disk.file.get (ERROR_METHOD_NOT_FOUND) y urlDownload+auth
 *  (devuelve el HTML de login, no el binario) fallan SIEMPRE para adjuntos de Open Lines/WhatsApp —
 *  se dejan como respaldo por si algún archivo sí es accesible por esa vía, pero la que de verdad
 *  funciona es imbot.v2.File.download (API "Chatbots 2.0"): pensada específicamente para que un BOT
 *  baje un adjunto de un chat con sus propias credenciales (scope imbot, ya en uso por
 *  imbot.message.add), sin necesitar ser "participante" a nivel de disco. */
async function downloadChatFile(f: BxFile, params: any, auth: Auth, botId?: number): Promise<Buffer | null> {
  const chatId = Number(params?.CHAT_ID ?? params?.TO_CHAT_ID) || undefined;

  // A) imbot.v2.File.download — la vía soportada para bots (ver comentario de la función).
  if (botId) {
    try {
      const r = await callBitrix<{ downloadUrl?: string }>('imbot.v2.File.download', { botId, fileId: f.id }, auth);
      if (r?.downloadUrl) {
        const buf = await fetchBinary(r.downloadUrl, 'imbot.v2.File.download', f.id);
        if (buf) return buf;
      } else {
        log.warn('media: imbot.v2.File.download sin downloadUrl', { id: f.id, keys: r ? Object.keys(r) : null });
      }
    } catch (e) {
      log.warn('media: imbot.v2.File.download error', { id: f.id, err: String(e) });
    }
  }

  // B) disk.file.get con el TOKEN DEL BOT → DOWNLOAD_URL firmada (REST). Respaldo: en la práctica dio
  // ACCESS_DENIED para adjuntos de Open Lines (el bot no tiene acceso a nivel de disco a ese archivo).
  try {
    const env = await callBitrixEnvelope<any>('disk.file.get', { id: f.id }, auth);
    const url = env.result?.DOWNLOAD_URL;
    if (url) {
      const buf = await fetchBinary(url, 'disk.file.get(bot)', f.id);
      if (buf) return buf;
    } else {
      log.warn('media: disk.file.get(bot) sin DOWNLOAD_URL', { id: f.id, keys: env.result ? Object.keys(env.result) : null });
    }
  } catch (e) {
    log.warn('media: disk.file.get(bot) error', { id: f.id, err: String(e) });
  }

  // C) im.disk.file.get. Respaldo: en la práctica dio ERROR_METHOD_NOT_FOUND en este portal.
  try {
    const res: any = await callBitrix('im.disk.file.get', { chatId, id: f.id, fileId: f.id }, auth);
    log.info('media: im.disk.file.get respuesta', { id: f.id, shape: res && typeof res === 'object' ? Object.keys(res) : String(res).slice(0, 120) });
    const url = res?.DOWNLOAD_URL ?? res?.downloadUrl ?? res?.urlDownload ?? res?.link;
    if (url) {
      const buf = await fetchBinary(url, 'im.disk.file.get', f.id);
      if (buf) return buf;
    }
  } catch (e) {
    log.warn('media: im.disk.file.get error', { id: f.id, err: String(e) });
  }

  // D) urlDownload del evento + token OAuth. Respaldo: en la práctica devuelve el HTML de login (esa
  // URL apunta a una controladora pensada para sesión de navegador, no para un bearer token de REST).
  if (f.urlDownload) {
    const buf = await fetchBinary(authUrl(f.urlDownload, auth), 'urlDownload+auth', f.id);
    if (buf) return buf;
  }

  return null;
}

/** Baja los adjuntos del evento y los devuelve en base64 (imágenes para visión, audios para STT).
 *  `botId` es necesario para imbot.v2.File.download (ver downloadChatFile) — sin él, esa vía se
 *  salta y solo quedan los respaldos que en la práctica no funcionan para adjuntos de Open Lines. */
export async function extractIncomingMedia(params: any, auth: Auth, botId?: number): Promise<IncomingMedia[]> {
  const files = collectFiles(params);
  if (!files.length) return [];
  log.info('media: adjuntos detectados', {
    count: files.length,
    files: files.map((f) => ({ id: f.id, type: f.type, ext: f.extension, name: f.name })),
  });

  const out: IncomingMedia[] = [];
  for (const f of files.slice(0, MAX_FILES)) {
    const kind = kindOf(f);
    const buf = await downloadChatFile(f, params, auth, botId);
    if (!buf) {
      log.warn('media: no se pudo bajar el adjunto por ninguna vía', { id: f.id, name: f.name });
      continue;
    }
    out.push({ kind, mediaType: mimeOf(f, kind), base64: buf.toString('base64'), name: f.name, bytes: buf.length });
    log.info('media: adjunto bajado', { id: f.id, name: f.name, kind, mediaType: mimeOf(f, kind), bytes: buf.length });
  }
  return out;
}
