import { callCrm } from '../bitrix/client';
import { config } from '../config';
import { log } from '../log';
import type { Auth } from '../store';

/**
 * El brochure como ARCHIVO, no como enlace.
 *
 * Hasta ahora el bot mandaba una URL del visor de Bitrix. Funciona, pero no es lo mismo: la persona
 * tiene que salir de WhatsApp, abrir el navegador y a veces iniciar sesión. Muchos no lo hacen. El
 * PDF, en cambio, le llega al teléfono y se queda ahí.
 *
 * Los PDF ya están en el Drive de Bitrix, en la carpeta de Carver. Acá se los busca por nombre y se
 * obtiene su URL de descarga directa, que es lo que ChatApp necesita para entregarlos.
 *
 * El matching es deterministico y se niega ante la duda: mandar el brochure de otro programa es
 * peor que no mandar ninguno, porque la persona lee condiciones, duración y precios que no son los
 * suyos y decide con eso.
 */

type ArchivoDrive = { id: number; nombre: string };

const CACHE_MS = 30 * 60_000;
let cache: { at: number; archivos: ArchivoDrive[] } | null = null;

const normalizar = (s: string) =>
  (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Palabras que no distinguen un programa de otro y solo ensucian la comparación.
 *
 * Incluye el TIPO ("licenciatura", "maestria"...) a propósito: en el Drive los archivos se llaman
 * "L. Psicología" y "M. Psicología", abreviado, así que exigir la palabra completa no calzaría
 * nunca. El tipo igual se comprueba aparte, comparando esa inicial, que es lo que de verdad separa
 * la licenciatura de la maestría del mismo tema.
 */
const VACIAS = new Set([
  'de', 'del', 'la', 'el', 'en', 'y', 'carver', 'university', 'pdf',
  'licenciatura', 'maestria', 'magister', 'master', 'bachelor',
]);

function significativas(s: string): string[] {
  return normalizar(s)
    .split(' ')
    .filter((w) => w.length >= 4 && !VACIAS.has(w));
}

/** "L." y "M." son como Carver nombra sus archivos: licenciatura y maestría. */
function tipoDelArchivo(nombre: string): 'licenciatura' | 'maestria' | null {
  const n = (nombre ?? '').trim().toLowerCase();
  if (n.startsWith('l.')) return 'licenciatura';
  if (n.startsWith('m.')) return 'maestria';
  return null;
}

function tipoDelPrograma(programa: string): 'licenciatura' | 'maestria' | null {
  const p = normalizar(programa);
  if (p.startsWith('licenciatura') || p.startsWith('bachelor')) return 'licenciatura';
  if (p.startsWith('maestria') || p.startsWith('master') || p.startsWith('magister')) return 'maestria';
  return null;
}

async function listarPdfs(auth: Auth): Promise<ArchivoDrive[]> {
  const ahora = Date.now();
  if (cache && ahora - cache.at < CACHE_MS) return cache.archivos;
  if (!config.driveFolderBrochuresCarver) return [];
  try {
    const r: any = await callCrm('disk.folder.getchildren', { id: config.driveFolderBrochuresCarver }, auth);
    const archivos = (Array.isArray(r) ? r : [])
      .filter((h: any) => h?.TYPE !== 'folder' && /\.pdf$/i.test(String(h?.NAME ?? '')))
      .map((h: any) => ({ id: Number(h.ID), nombre: String(h.NAME) }));
    cache = { at: ahora, archivos };
    return archivos;
  } catch (e) {
    log.warn('brochureArchivo: no se pudo listar la carpeta del Drive', { err: String(e) });
    return [];
  }
}

export type ResultadoArchivo =
  | { ok: true; fileId: number; nombre: string; url: string }
  | { ok: false; motivo: 'sin_carpeta' | 'sin_archivo' | 'ambiguo' | 'sin_url' };

/**
 * El PDF que corresponde a un programa, con su URL de descarga.
 *
 * Entre varios candidatos se prefiere el de nombre más corto: los duplicados del Drive llevan
 * sufijos como "(1)", y el original es el que no los tiene.
 */
export async function archivoDelBrochure(programa: string, auth: Auth): Promise<ResultadoArchivo> {
  if (!config.driveFolderBrochuresCarver) return { ok: false, motivo: 'sin_carpeta' };
  const archivos = await listarPdfs(auth);
  if (!archivos.length) return { ok: false, motivo: 'sin_archivo' };

  const tipo = tipoDelPrograma(programa);
  const palabras = significativas(programa);
  if (!palabras.length) return { ok: false, motivo: 'sin_archivo' };

  const candidatos = archivos.filter((a) => {
    // El tipo tiene que coincidir: "M. Psicología" y "L. Psicología" comparten TODAS las palabras
    // significativas, y sin esta comprobación una licenciatura recibiría el brochure de la maestría.
    const t = tipoDelArchivo(a.nombre);
    if (tipo && t && t !== tipo) return false;
    const n = normalizar(a.nombre);
    return palabras.every((w) => n.includes(w));
  });
  if (!candidatos.length) return { ok: false, motivo: 'sin_archivo' };

  const elegido = candidatos.slice().sort((a, b) => a.nombre.length - b.nombre.length)[0];
  // Dos archivos distintos que no son el mismo con sufijo: no se elige por sorteo.
  // El "(1)" se quita ANTES de normalizar: normalizar borra los paréntesis y dejaría un "1" suelto
  // que haría ver dos copias del mismo archivo como archivos distintos.
  const base = (s: string) => normalizar(s.replace(/\(\d+\)/g, ' '));
  if (candidatos.some((c) => base(c.nombre) !== base(elegido.nombre))) return { ok: false, motivo: 'ambiguo' };

  try {
    const f: any = await callCrm('disk.file.get', { id: elegido.id }, auth);
    const url = String(f?.DOWNLOAD_URL ?? '');
    if (!/^https:\/\//.test(url)) return { ok: false, motivo: 'sin_url' };
    return { ok: true, fileId: elegido.id, nombre: elegido.nombre, url };
  } catch (e) {
    log.warn('brochureArchivo: no se pudo obtener la URL de descarga', { err: String(e), fileId: elegido.id });
    return { ok: false, motivo: 'sin_url' };
  }
}

/** Para las pruebas: el listado del Drive se cachea media hora. */
export function _limpiarCacheBrochureArchivo(): void {
  cache = null;
}

/** Teléfono de WhatsApp de la persona, desde su ficha de contacto. */
async function telefonoDelContacto(contactId: number | undefined, auth: Auth): Promise<string | null> {
  if (!contactId) return null;
  try {
    const c: any = await callCrm('crm.contact.get', { id: contactId, select: ['PHONE'] }, auth);
    const bruto = Array.isArray(c?.PHONE) ? String(c.PHONE[0]?.VALUE ?? '') : '';
    const limpio = bruto.replace(/[\s()-]/g, '');
    return /^\+?[1-9]\d{7,14}$/.test(limpio) ? limpio : null;
  } catch (e) {
    log.warn('brochureArchivo: no se pudo leer el teléfono del contacto', { err: String(e), contactId });
    return null;
  }
}

export type EnvioBrochure =
  | { enviado: true; nombre: string }
  | { enviado: false; motivo: 'sin_telefono' | 'sin_archivo' | 'fallo_envio' | 'desactivado' };

/**
 * Manda el PDF del brochure al WhatsApp de la persona.
 *
 * Sale por ChatApp y no por Canales Abiertos porque `imbot.message.add` solo envía texto. Es el
 * mismo número por el que conversa el bot, así que para la persona es un archivo más en la misma
 * conversación.
 *
 * Nunca lanza: si algo falla, quien llama sigue entregando el enlace, que es el comportamiento
 * anterior. Quedarse sin brochure por un problema de envío sería peor que mandar un enlace.
 */
export async function enviarBrochurePorWhatsApp(
  programa: string,
  entities: { contact?: number },
  auth: Auth,
): Promise<EnvioBrochure> {
  if (!config.driveFolderBrochuresCarver || !config.chatappLicenseId) return { enviado: false, motivo: 'desactivado' };
  const tel = await telefonoDelContacto(entities?.contact, auth);
  if (!tel) return { enviado: false, motivo: 'sin_telefono' };
  const archivo = await archivoDelBrochure(programa, auth);
  if (!archivo.ok) return { enviado: false, motivo: 'sin_archivo' };
  try {
    const { enviarArchivo } = await import('../whatsapp/chatapp');
    const r = await enviarArchivo({
      phoneE164: tel,
      url: archivo.url,
      nombreArchivo: archivo.nombre,
      descripcion: `Brochure — ${programa}`,
    });
    if (!r.ok) {
      log.warn('brochureArchivo: ChatApp rechazó el envío', { err: r.error, programa });
      return { enviado: false, motivo: 'fallo_envio' };
    }
    log.info('brochure enviado como PDF por WhatsApp', { programa, archivo: archivo.nombre });
    return { enviado: true, nombre: archivo.nombre };
  } catch (e) {
    log.warn('brochureArchivo: falló el envío', { err: String(e), programa });
    return { enviado: false, motivo: 'fallo_envio' };
  }
}
