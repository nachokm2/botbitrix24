import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';

// Importar documentos de admisión o finanzas al panel: el texto de un Word (con sus enlaces y tablas),
// la propuesta del modelo con la forma de la sección, y los límites de la ruta. Nada se guarda acá.
process.env.MARCA = 'carver';
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

const pedidosModelo: any[] = [];
let respuestaModelo: any = null;
mock.module('../src/ai/client.ts', {
  namedExports: {
    anthropic: { messages: { create: async (req: any) => (pedidosModelo.push(req), respuestaModelo) } },
    REASONER: 'modelo-de-prueba',
    CLASSIFIER: 'modelo-de-prueba',
  },
});

const { textoDeDocx } = await import('../src/core/documentos');
const { panelImportar, _reiniciarTopeImportar } = await import('../src/routes/panelImportar');

/** Un zip mínimo con estas entradas (deflate o guardadas), suficiente para un .docx de prueba. */
function zip(entradas: Array<{ nombre: string; texto: string; guardado?: boolean }>): Buffer {
  const locales: Buffer[] = [];
  const centrales: Buffer[] = [];
  let offset = 0;
  for (const e of entradas) {
    const crudo = Buffer.from(e.texto, 'utf8');
    const datos = e.guardado ? crudo : deflateRawSync(crudo);
    const nombre = Buffer.from(e.nombre, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(e.guardado ? 0 : 8, 8);
    local.writeUInt32LE(datos.length, 18);
    local.writeUInt32LE(crudo.length, 22);
    local.writeUInt16LE(nombre.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(e.guardado ? 0 : 8, 10);
    central.writeUInt32LE(datos.length, 20);
    central.writeUInt32LE(crudo.length, 24);
    central.writeUInt16LE(nombre.length, 28);
    central.writeUInt32LE(offset, 42);
    locales.push(local, nombre, datos);
    centrales.push(central, nombre);
    offset += 30 + nombre.length + datos.length;
  }
  const dir = Buffer.concat(centrales);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(entradas.length, 8);
  fin.writeUInt16LE(entradas.length, 10);
  fin.writeUInt32LE(dir.length, 12);
  fin.writeUInt32LE(offset, 16);
  return Buffer.concat([...locales, dir, fin]);
}

const DOCUMENTO = `<?xml version="1.0"?><w:document xmlns:w="w" xmlns:r="r"><w:body>
<w:p><w:r><w:t>Medios de pago &amp; enlaces</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Matrícula USD 50: </w:t></w:r><w:hyperlink r:id="rId7"><w:r><w:t>pagar aquí</w:t></w:r></w:hyperlink></w:p>
<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> HYPERLINK "https://carver.university/es/portal-de-pagos/" </w:instrText></w:r><w:r><w:t>Portal</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>C05</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>todos</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2027-01-25</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>`;
const RELS = `<?xml version="1.0"?><Relationships><Relationship Id="rId7" Type="http://schemas/hyperlink" Target="https://www.paypal.com/ncp/payment/ABC&amp;x=1" TargetMode="External"/></Relationships>`;
const docx = () => zip([{ nombre: 'word/_rels/document.xml.rels', texto: RELS, guardado: true }, { nombre: 'word/document.xml', texto: DOCUMENTO }]);

// ── El texto de un Word ──────────────────────────────────────────────────────────────────────────
test('el texto de un Word conserva los enlaces escondidos, las tablas y los caracteres especiales', () => {
  const t = textoDeDocx(docx());
  assert.match(t, /Medios de pago & enlaces/);
  assert.match(t, /Matrícula USD 50: pagar aquí \[https:\/\/www\.paypal\.com\/ncp\/payment\/ABC&x=1\]/);
  assert.match(t, /\[https:\/\/carver\.university\/es\/portal-de-pagos\/\]/);
  assert.match(t, /C05 \| todos \| 2027-01-25/);
});

test('un zip que se infla de más no se procesa', () => {
  const bomba = zip([{ nombre: 'word/document.xml', texto: `<w:p><w:t>${'a'.repeat(25 * 1024 * 1024)}</w:t></w:p>` }]);
  assert.throws(() => textoDeDocx(bomba));
});

// ── La ruta ──────────────────────────────────────────────────────────────────────────────────────
function respuesta() {
  const r: any = { statusCode: 200, locals: { editor: { id: 4173, nombre: 'Rodrigo Palma' } } };
  r.status = (c: number) => ((r.statusCode = c), r);
  r.json = (b: any) => ((r.cuerpo = b), r);
  return r;
}
const pedido = (destino: string, cuerpo: Buffer, nombre = 'doc.docx') => ({ query: { destino, nombre }, body: cuerpo }) as any;
const usarHerramienta = (name: string, input: any) => ({ content: [{ type: 'tool_use', id: 't1', name, input }], usage: {} });

beforeEach(() => {
  pedidosModelo.length = 0;
  _reiniciarTopeImportar();
});

test('un Word para Acciones: el modelo recibe su texto y la propuesta vuelve con la forma de la sección', async () => {
  respuestaModelo = usarHerramienta('proponer_medios_de_pago', {
    enlacesPayPal: [{ concepto: 'matricula', montoUsd: 50, url: 'https://www.paypal.com/ncp/payment/ABC&x=1' }],
    portalFlywire: 'https://carver.university/es/portal-de-pagos/',
  });
  const res = respuesta();
  await panelImportar(pedido('acciones', docx(), 'Medios_de_Pago.docx'), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.cuerpo.propuesta.enlacesPayPal[0].montoUsd, 50);
  const req = pedidosModelo[0];
  assert.deepEqual(req.tool_choice, { type: 'tool', name: 'proponer_medios_de_pago' });
  assert.match(req.messages[0].content[0].text, /payment\/ABC/, 'el texto del Word, con el enlace, llega al modelo');
});

test('un PDF para un tema del conocimiento va al modelo como documento, con el esquema de ese tema', async () => {
  respuestaModelo = usarHerramienta('proponer_filas', { entradas: [{ ciclo: 'C05', programa: 'todos', inicioClases: '2027-01-25', cierrePostulacion: '2027-01-22' }] });
  const res = respuesta();
  await panelImportar(pedido('conocimiento:calendario_ingresos', Buffer.from('%PDF-1.7 calendario'), 'Calendario.pdf'), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.cuerpo.propuesta.entradas[0].ciclo, 'C05');
  const req = pedidosModelo[0];
  assert.equal(req.messages[0].content[0].type, 'document');
  const campos = Object.keys(req.tools[0].input_schema.properties.entradas.items.properties);
  assert.deepEqual(campos, ['ciclo', 'programa', 'inicioClases', 'cierrePostulacion']);
});

test('destinos desconocidos, archivos que no son Word ni PDF y el tope por persona', async () => {
  const destino = respuesta();
  await panelImportar(pedido('precios', Buffer.from('%PDF-1.7')), destino);
  assert.equal(destino.statusCode, 400);
  const raro = respuesta();
  await panelImportar(pedido('acciones', Buffer.from('hola, soy un txt')), raro);
  assert.equal(raro.statusCode, 400);
  assert.equal(pedidosModelo.length, 0, 'nada llegó al modelo');

  respuestaModelo = usarHerramienta('proponer_medios_de_pago', { enlacesPayPal: [] });
  _reiniciarTopeImportar();
  for (let i = 0; i < 10; i++) {
    const r = respuesta();
    await panelImportar(pedido('acciones', Buffer.from('%PDF-1.7')), r);
    assert.equal(r.statusCode, 200);
  }
  const tope = respuesta();
  await panelImportar(pedido('acciones', Buffer.from('%PDF-1.7')), tope);
  assert.equal(tope.statusCode, 429);
});
