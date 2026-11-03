import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Brochures en PDF subidos desde el panel: solo PDFs de verdad, con un enlace que no se puede adivinar,
// y que el bot puede entregar (pasa la validación de "Programas y modalidad").
process.env.MARCA = 'carver';
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';
process.env.BASE_URL = 'https://botcarver-production.up.railway.app';

const guardados = new Map<string, { nombre: string; tipo: string; contenido: Buffer; autor: any }>();
mock.module('../src/store/db.ts', {
  namedExports: {
    dbArchivoGuardar: async (a: any) => {
      const token = `tok${String(guardados.size).padStart(21, '0')}`;
      guardados.set(token, a);
      return { token };
    },
    dbArchivoLeer: async (token: string) => guardados.get(token) ?? null,
  },
});

const { panelSubirArchivo, servirArchivo, MAX_PDF_BYTES } = await import('../src/routes/panelArchivos');
const { programasPorDefecto, programasBase, validarProgramas } = await import('../src/core/ajustesProgramas');

function respuesta() {
  const r: any = { statusCode: 200, headers: {} as Record<string, string>, locals: { editor: { id: 4173, nombre: 'Rodrigo Palma' } } };
  r.status = (c: number) => ((r.statusCode = c), r);
  r.json = (b: any) => ((r.cuerpo = b), r);
  r.send = (b: any) => ((r.cuerpo = b), r);
  r.set = (k: string, v: string) => ((r.headers[k.toLowerCase()] = v), r);
  return r;
}
const PDF = Buffer.from('%PDF-1.7\n% brochure de prueba\n%%EOF');

test('un PDF se guarda y vuelve con un enlace del bot, nombrado según el programa', async () => {
  const res = respuesta();
  await panelSubirArchivo({ body: PDF, query: { nombre: 'Maestría en Psicología' } } as any, res);
  assert.equal(res.statusCode, 200);
  assert.match(res.cuerpo.url, /^https:\/\/botcarver-production\.up\.railway\.app\/archivos\/[A-Za-z0-9_-]{20,40}\/maestria-en-psicologia\.pdf$/);
  assert.equal([...guardados.values()].at(-1)!.autor.id, 4173, 'queda quién lo subió');
});

test('se rechaza lo que no es un PDF aunque diga .pdf, lo vacío y lo demasiado pesado', async () => {
  const falso = respuesta();
  await panelSubirArchivo({ body: Buffer.from('<html>no soy un pdf</html>'), query: { nombre: 'x.pdf' } } as any, falso);
  assert.equal(falso.statusCode, 400);
  const vacio = respuesta();
  await panelSubirArchivo({ body: Buffer.alloc(0), query: {} } as any, vacio);
  assert.equal(vacio.statusCode, 400);
  const grande = respuesta();
  await panelSubirArchivo({ body: Buffer.concat([PDF, Buffer.alloc(MAX_PDF_BYTES)]), query: {} } as any, grande);
  assert.equal(grande.statusCode, 413);
});

test('el enlace sirve el PDF a cualquiera, y un token inválido o desconocido da 404', async () => {
  const subida = respuesta();
  await panelSubirArchivo({ body: PDF, query: { nombre: 'MBA' } } as any, subida);
  // /archivos/<token>/<nombre>
  const [, , token, nombre] = new URL(subida.cuerpo.url).pathname.split('/');
  const res = respuesta();
  await servirArchivo({ params: { token, nombre } } as any, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.ok(Buffer.isBuffer(res.cuerpo) && res.cuerpo.equals(PDF));

  const malo = respuesta();
  await servirArchivo({ params: { token: '../etc/passwd', nombre: 'x.pdf' } } as any, malo);
  assert.equal(malo.statusCode, 404);
  const desconocido = respuesta();
  await servirArchivo({ params: { token: 'x'.repeat(24), nombre: 'x.pdf' } } as any, desconocido);
  assert.equal(desconocido.statusCode, 404);
});

// Documentos de "Conocimiento" (dirección de Carver, 03-11-2026): el título de ejemplo llegó como JPG.
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

test('para Conocimiento se suben también imágenes JPG y PNG, y se sirven como imagen', async () => {
  const jpg = respuesta();
  await panelSubirArchivo({ body: JPG, query: { nombre: 'Diploma Carver.jpg' } } as any, jpg);
  assert.equal(jpg.statusCode, 200);
  assert.match(jpg.cuerpo.url, /\/diploma-carver\.jpg$/);
  const [, , token, nombre] = new URL(jpg.cuerpo.url).pathname.split('/');
  const res = respuesta();
  await servirArchivo({ params: { token, nombre } } as any, res);
  assert.equal(res.headers['content-type'], 'image/jpeg');

  const png = respuesta();
  await panelSubirArchivo({ body: PNG, query: { nombre: 'Licencia.png' } } as any, png);
  assert.match(png.cuerpo.url, /\/licencia\.png$/);
});

test('el brochure de un programa sigue siendo solo PDF, y un GIF no entra en ningún lado', async () => {
  const imagenComoBrochure = respuesta();
  await panelSubirArchivo({ body: JPG, query: { nombre: 'MBA', solo: 'pdf' } } as any, imagenComoBrochure);
  assert.equal(imagenComoBrochure.statusCode, 400);
  assert.equal(imagenComoBrochure.cuerpo.error, 'El archivo no es un PDF.');
  const pdf = respuesta();
  await panelSubirArchivo({ body: PDF, query: { nombre: 'MBA', solo: 'pdf' } } as any, pdf);
  assert.equal(pdf.statusCode, 200);
  const gif = respuesta();
  await panelSubirArchivo({ body: Buffer.from('GIF89a contenido'), query: { nombre: 'x.gif' } } as any, gif);
  assert.equal(gif.statusCode, 400);
});

test('el enlace de un PDF subido se puede publicar como brochure de un programa', async () => {
  const subida = respuesta();
  await panelSubirArchivo({ body: PDF, query: { nombre: 'Maestría en Psicología' } } as any, subida);
  const d = programasPorDefecto();
  const slug = programasBase().find((b) => b.nombre === 'Maestría en Psicología')!.slug;
  const v = validarProgramas({ programas: { ...d.programas, [slug]: { ...d.programas[slug], brochureUrl: subida.cuerpo.url } } });
  assert.ok(v.ok, JSON.stringify(!v.ok && v.errores));
});
