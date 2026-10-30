import { inflateRawSync } from 'node:zlib';

/**
 * Texto de un documento de Word (.docx) para el importador del panel (ai/importarDocumento.ts).
 *
 * Un .docx es un zip con XML adentro. Para no sumar una dependencia por esto se lee el zip a mano (solo
 * lo necesario: el directorio central, entradas guardadas o comprimidas con deflate) y se saca el texto
 * del XML. Lo que importa conservar, porque es justo lo que trae un documento de la dirección:
 * - los ENLACES, que en Word casi siempre son un texto con el enlace escondido detrás;
 * - las TABLAS, que se leen fila por fila con las celdas separadas por " | ".
 *
 * Los PDF no pasan por acá: el modelo los lee directamente.
 */

const MAX_DESCOMPRIMIDO = 20 * 1024 * 1024; // un zip que se infla más que esto no es un documento normal

export const esPdf = (b: Buffer) => b.subarray(0, 5).toString('latin1') === '%PDF-';
export const esZip = (b: Buffer) => b.length > 4 && b.readUInt32LE(0) === 0x04034b50;

/** Las entradas del zip que interesan, ya descomprimidas. */
function leerZip(b: Buffer, nombres: string[]): Map<string, Buffer> {
  // Fin del directorio central: está en los últimos 22 bytes más un comentario opcional.
  let fin = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) {
      fin = i;
      break;
    }
  }
  if (fin < 0) throw new Error('no es un zip válido');
  const total = b.readUInt16LE(fin + 10);
  let p = b.readUInt32LE(fin + 16);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < total && p + 46 <= b.length; n++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error('directorio del zip dañado');
    const metodo = b.readUInt16LE(p + 10);
    const comprimido = b.readUInt32LE(p + 20);
    const largoNombre = b.readUInt16LE(p + 28);
    const largoExtra = b.readUInt16LE(p + 30);
    const largoComentario = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    const nombre = b.subarray(p + 46, p + 46 + largoNombre).toString('utf8');
    p += 46 + largoNombre + largoExtra + largoComentario;
    if (!nombres.includes(nombre)) continue;
    if (b.readUInt32LE(local) !== 0x04034b50) throw new Error('entrada del zip dañada');
    const inicio = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const datos = b.subarray(inicio, inicio + comprimido);
    if (metodo === 0) out.set(nombre, datos);
    else if (metodo === 8) out.set(nombre, inflateRawSync(datos, { maxOutputLength: MAX_DESCOMPRIMIDO }));
    else throw new Error(`compresión no soportada (${metodo})`);
  }
  return out;
}

const decodificar = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

/** El texto de un .docx, con los enlaces entre corchetes después de su texto y las tablas por fila. */
export function textoDeDocx(b: Buffer): string {
  const partes = leerZip(b, ['word/document.xml', 'word/_rels/document.xml.rels']);
  const doc = partes.get('word/document.xml');
  if (!doc) throw new Error('no es un documento de Word');
  const rels = new Map<string, string>();
  const xmlRels = partes.get('word/_rels/document.xml.rels')?.toString('utf8') ?? '';
  for (const m of xmlRels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
    const destino = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
    if (id && destino && /hyperlink/i.test(m[0])) rels.set(id, decodificar(destino));
  }
  const xml = doc
    .toString('utf8')
    // Enlace con el texto visible adentro: queda "texto [https://…]".
    .replace(/<w:hyperlink\b([^>]*)>([\s\S]*?)<\/w:hyperlink>/g, (_m, attrs: string, dentro: string) => {
      const id = /r:id="([^"]+)"/.exec(attrs)?.[1];
      const url = id ? rels.get(id) : undefined;
      return url ? `${dentro}<w:t> [${url}]</w:t>` : dentro;
    })
    // Enlace como campo de Word (HYPERLINK "…"): el código del campo trae la dirección.
    .replace(/<w:instrText\b[^>]*>\s*HYPERLINK\s+"([^"]+)"[^<]*<\/w:instrText>/g, (_m, url: string) => `<w:t> [${url}] </w:t>`)
    .replace(/<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/g, '')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    // Una celda trae sus propios párrafos: dentro de ella no cortan la fila.
    .replace(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g, (_m, dentro: string) => `${dentro.replace(/<\/w:p>/g, ' ')} | `)
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<\/w:p>/g, '\n');
  const texto = decodificar(xml.replace(/<[^>]+>/g, ''));
  return texto
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').replace(/( \| )+$/, '').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
