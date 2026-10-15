import { getJson, setJson } from '../store/kv';
import { config } from '../config';
import { log } from '../log';

/**
 * Proveedor ChatApp — por donde sale el WhatsApp de Carver.
 *
 * El bot conversa a través del conector WACA/ChatApp de Canales Abiertos, así que un mensaje
 * proactivo tiene que salir por ESE mismo número: si sale por otro, la persona responde a un lugar
 * donde el bot no escucha y la conversación se pierde.
 *
 * No alcanzaba con el proveedor genérico (WA_PROVIDER=custom, cabeceras fijas) porque la
 * autenticación es un token de 24 horas con un tope de 100 emisiones diarias por email+appId: pedir
 * uno por mensaje agotaría la cuota a los 100 envíos. Por eso se cachea.
 *
 * Contrato (api.chatapp.online/docs):
 *   POST /v1/tokens                      {email, password, appId} -> {accessToken, refreshToken}
 *   GET  /v1/licenses/{l}/messengers/{m}/templates
 *   POST /v1/licenses/{l}/messengers/{m}/chats/{tel}/messages/template  {template:{id, params}}
 * En todas, la cabecera es `Authorization: <accessToken>` (sin "Bearer").
 */

const BASE = 'https://api.chatapp.online/v1';
const MENSAJERO = 'caWhatsApp'; // el canal de WhatsApp Cloud API de ChatApp
const CLAVE_TOKEN = 'chatapp:token';
const VIDA_TOKEN_SEG = 23 * 3600; // el token vive 24 h; se renueva una hora antes

export type PlantillaChatApp = {
  id: string;
  elementName: string;
  languageCode: string;
  status: string;
  templateType: string;
  data: string;
};

let enMemoria: { token: string; hasta: number } | null = null;

/** Devuelve un accessToken válido, reutilizando el cacheado. `forzar` lo renueva tras un 401. */
async function token(forzar = false): Promise<string> {
  const ahora = Date.now();
  if (!forzar) {
    if (enMemoria && enMemoria.hasta > ahora) return enMemoria.token;
    const guardado = await getJson<{ token: string; hasta: number }>(CLAVE_TOKEN);
    if (guardado?.token && guardado.hasta > ahora) {
      enMemoria = guardado;
      return guardado.token;
    }
  }
  if (!config.chatappEmail || !config.chatappPassword || !config.chatappAppId) {
    throw new Error('Faltan CHATAPP_EMAIL / CHATAPP_PASSWORD / CHATAPP_APP_ID');
  }
  const res = await fetch(`${BASE}/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: config.chatappEmail,
      password: config.chatappPassword,
      appId: config.chatappAppId,
    }),
  });
  const j: any = await res.json().catch(() => ({}));
  const access = j?.data?.accessToken ?? j?.accessToken;
  if (!res.ok || !access) {
    throw new Error(`ChatApp /tokens HTTP ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  }
  const nuevo = { token: String(access), hasta: ahora + VIDA_TOKEN_SEG * 1000 };
  enMemoria = nuevo;
  await setJson(CLAVE_TOKEN, nuevo, VIDA_TOKEN_SEG).catch(() => {});
  log.info('ChatApp: token renovado');
  return nuevo.token;
}

/** Petición autenticada. Ante un 401 renueva el token UNA vez y reintenta. */
async function pedir(ruta: string, init: RequestInit = {}, reintento = false): Promise<any> {
  const t = await token(reintento);
  const res = await fetch(`${BASE}${ruta}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: t, ...(init.headers ?? {}) },
  });
  if (res.status === 401 && !reintento) return pedir(ruta, init, true);
  const texto = await res.text();
  let j: any = {};
  try {
    j = JSON.parse(texto);
  } catch {
    /* respuesta no-JSON: se informa el texto crudo más abajo */
  }
  if (!res.ok || j?.success === false) {
    throw new Error(`ChatApp ${ruta} HTTP ${res.status}: ${texto.slice(0, 250)}`);
  }
  return j;
}

/** Plantillas de la licencia, para elegir cuál usar y confirmar que está aprobada. */
export async function listarPlantillas(licenseId = config.chatappLicenseId): Promise<PlantillaChatApp[]> {
  const j = await pedir(`/licenses/${licenseId}/messengers/${MENSAJERO}/templates`);
  const items = j?.data?.items ?? [];
  return Array.isArray(items) ? items : [];
}

/**
 * Envía una plantilla. `templateId` es el UUID de ChatApp, NO el nombre de Meta: la API identifica
 * la plantilla por id, y el nombre solo sirve para encontrarla en el listado.
 */
export async function enviarPlantilla(opts: {
  phoneE164: string;
  templateId: string;
  params: string[];
  licenseId?: number;
}): Promise<{ ok: true; messageId?: string } | { ok: false; error: string }> {
  const licencia = opts.licenseId ?? config.chatappLicenseId;
  if (!licencia) return { ok: false, error: 'Falta CHATAPP_LICENSE_ID' };
  if (!opts.templateId) return { ok: false, error: 'Falta el id de la plantilla' };
  const chatId = opts.phoneE164.replace(/^\+/, ''); // la ruta lleva el número sin "+"
  try {
    const j = await pedir(`/licenses/${licencia}/messengers/${MENSAJERO}/chats/${chatId}/messages/template`, {
      method: 'POST',
      body: JSON.stringify({ template: { id: opts.templateId, params: opts.params } }),
    });
    return { ok: true, messageId: j?.data?.id };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 300) };
  }
}

/**
 * Envía un ARCHIVO (el brochure en PDF) al chat de WhatsApp de una persona.
 *
 * ChatApp acepta una URL y él mismo descarga el archivo, así que no hay que subir bytes: basta la
 * URL de descarga que da el Drive de Bitrix. Verificado contra la API el 15-10-2026 — el campo se
 * llama `file`, no `url`, y el endpoint es `/messages/file`.
 *
 * Por qué no se manda por Canales Abiertos: `imbot.message.add` solo envía texto. Un enlace en el
 * chat no es lo mismo que el PDF — la persona tiene que abrir el navegador, a veces iniciar sesión,
 * y muchos simplemente no lo hacen. El archivo llega a su WhatsApp y se queda ahí.
 *
 * Solo funciona dentro de la ventana de 24 h de WhatsApp. Fuera de ella hay que usar una plantilla.
 */
export async function enviarArchivo(opts: {
  phoneE164: string;
  /** URL de descarga directa. Tiene que responder un archivo, no una página que lo muestre. */
  url: string;
  nombreArchivo: string;
  /** Texto que acompaña al archivo. Opcional: va como pie del documento en WhatsApp. */
  descripcion?: string;
  licenseId?: number;
}): Promise<{ ok: true; messageId?: string } | { ok: false; error: string }> {
  const licencia = opts.licenseId ?? config.chatappLicenseId;
  if (!licencia) return { ok: false, error: 'Falta CHATAPP_LICENSE_ID' };
  if (!/^https:\/\//.test(opts.url)) return { ok: false, error: 'La URL del archivo no es https' };
  const chatId = opts.phoneE164.replace(/^\+/, '');
  try {
    const j = await pedir(`/licenses/${licencia}/messengers/${MENSAJERO}/chats/${chatId}/messages/file`, {
      method: 'POST',
      body: JSON.stringify({
        file: opts.url,
        fileName: opts.nombreArchivo,
        ...(opts.descripcion ? { caption: opts.descripcion } : {}),
      }),
    });
    log.info('ChatApp: archivo enviado', { chatId, nombreArchivo: opts.nombreArchivo });
    return { ok: true, messageId: j?.data?.id };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 300) };
  }
}
