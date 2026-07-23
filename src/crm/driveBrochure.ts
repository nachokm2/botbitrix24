import { callCrmEnvelope, type BitrixEnvelope } from '../bitrix/client';
import { config } from '../config';
import { log } from '../log';
import type { Auth } from '../store';

// Matching del "programa de interés" contra los PDF reales en el Drive de Bitrix24
// ("Brochures Bot/Diplomado|Magíster o Master|Especialidades"), cuyos archivos siguen el patrón
// "{Tipo} - {Nombre del programa}[ - Modalidad].pdf". Determinístico: si no hay match con
// suficiente confianza, no adjunta nada (mejor omitir que adjuntar el brochure equivocado).

const strip = (s: string) =>
  (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();

type Tipo = 'magister' | 'diplomado' | 'especialidad';

function detectarTipo(programa: string): Tipo | null {
  const s = strip(programa);
  if (/^(magister|master)\b/.test(s)) return 'magister';
  if (/^diplomado\b/.test(s)) return 'diplomado';
  if (/^especialidad\b/.test(s)) return 'especialidad';
  return null;
}

function folderIdPara(tipo: Tipo): number | undefined {
  const raw =
    tipo === 'magister' ? config.driveFolderMagister : tipo === 'diplomado' ? config.driveFolderDiplomado : config.driveFolderEspecialidad;
  const id = Number(raw);
  return id > 0 ? id : undefined;
}

/** Nombre "pelado" para comparar: sin el prefijo de tipo (catálogo: "Magíster en X" / Drive: "Magíster - X.pdf"),
 *  sin acentos, mayúsculas ni extensión. */
function nombrePelado(s: string): string {
  return strip(s)
    .replace(/^(magister|master|diplomado|especialidad)\s*(en|-|:)?\s*/i, '')
    .replace(/\.pdf$/i, '')
    .trim();
}

type Archivo = { ID: number; NAME: string };

/** Lista TODOS los archivos de una carpeta del Drive, paginando (disk.folder.getchildren solo
 *  devuelve una página por llamada; con ~130 diplomados hace falta más de una página). */
async function listarArchivos(folderId: number, auth: Auth): Promise<Archivo[]> {
  const out: Archivo[] = [];
  let start: number | undefined = 0;
  for (let page = 0; page < 20 && start !== undefined; page++) {
    const env: BitrixEnvelope<any[]> = await callCrmEnvelope<any[]>('disk.folder.getchildren', { id: folderId, start }, auth);
    for (const c of env.result ?? []) if (c.TYPE === 'file') out.push({ ID: Number(c.ID), NAME: String(c.NAME) });
    start = env.next;
  }
  return out;
}

function mejorMatch(archivos: Archivo[], target: string): Archivo | null {
  let mejor: { archivo: Archivo; score: number } | null = null;
  for (const a of archivos) {
    const candidato = nombrePelado(a.NAME);
    let score = 0;
    if (candidato === target) score = 100;
    else if (candidato.startsWith(target) || target.startsWith(candidato)) score = 80 - Math.abs(candidato.length - target.length);
    else if (candidato.includes(target) || target.includes(candidato)) score = 50;
    if (score > 0 && (!mejor || score > mejor.score)) mejor = { archivo: a, score };
  }
  return mejor && mejor.score >= 50 ? mejor.archivo : null;
}

/** Contenido de un archivo ya listo para setear un UF tipo "Archivo" vía crm.*.update
 *  (`fields[uf] = { fileData: [fileName, contenidoBase64] }` — la ÚNICA forma que Bitrix24
 *  realmente adjunta; referenciar el fileId existente con "n<id>" no funciona). */
export type BrochureEncontrado = { fileName: string; contenidoBase64: string };

/**
 * Busca, en la carpeta del Drive que corresponde al TIPO del programa (según BITRIX_DRIVE_FOLDER_*),
 * el PDF cuyo nombre calza mejor con `programaInteres`, y descarga su contenido (Bitrix24 no
 * soporta adjuntar un archivo ya existente por referencia; hay que volver a subir el contenido).
 * Devuelve null si no se puede determinar el tipo, falta configurar la carpeta correspondiente,
 * ningún archivo calza con confianza suficiente, o falla la descarga.
 */
export async function buscarBrochureDrive(programaInteres: string, auth: Auth): Promise<BrochureEncontrado | null> {
  const tipo = detectarTipo(programaInteres);
  if (!tipo) return null;
  const folderId = folderIdPara(tipo);
  if (!folderId) return null;

  const target = nombrePelado(programaInteres);
  if (!target) return null;

  try {
    const archivos = await listarArchivos(folderId, auth);
    const archivo = mejorMatch(archivos, target);
    if (!archivo) {
      log.warn('buscarBrochureDrive: sin match suficiente', { programaInteres, tipo, candidatos: archivos.length });
      return null;
    }

    const info: BitrixEnvelope<any> = await callCrmEnvelope<any>('disk.file.get', { id: archivo.ID }, auth);
    const downloadUrl = info.result?.DOWNLOAD_URL;
    if (!downloadUrl) {
      log.warn('buscarBrochureDrive: sin DOWNLOAD_URL', { programaInteres, fileId: archivo.ID });
      return null;
    }
    const r = await fetch(downloadUrl);
    if (!r.ok) {
      log.warn('buscarBrochureDrive: descarga falló', { programaInteres, fileId: archivo.ID, status: r.status });
      return null;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    return { fileName: archivo.NAME, contenidoBase64: buf.toString('base64') };
  } catch (e) {
    log.warn('buscarBrochureDrive falló', { err: String(e), programaInteres });
    return null;
  }
}
