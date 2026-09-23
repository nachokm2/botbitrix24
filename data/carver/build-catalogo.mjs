// Arma el catálogo de Carver University a partir de las fichas scrapeadas (paginas/*.md).
// Determinista: lo que no encuentra queda en null — NUNCA inventa un dato, porque el bot
// cotiza con esto. Re-ejecutable cuando Carver actualice el sitio.
//   node build-catalogo.mjs
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const DIR = 'paginas';
const OUT = 'carver.catalogo.json';

const limpiar = (s) =>
  String(s ?? '')
    .replace(/\\\*/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // markdown link -> texto
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Respuesta de una pregunta del FAQ: la primera línea no vacía después del "### <pregunta>". */
function faq(lineas, patron) {
  const i = lineas.findIndex((l) => /^###\s/.test(l) && patron.test(l));
  if (i < 0) return null;
  for (let j = i + 1; j < lineas.length; j++) {
    const t = limpiar(lineas[j]);
    if (!t) continue;
    if (/^#{1,6}\s/.test(lineas[j])) return null; // otra sección: no había respuesta
    return t;
  }
  return null;
}

function tras(lineas, patron, { max = 3 } = {}) {
  const i = lineas.findIndex((l) => patron.test(l));
  if (i < 0) return null;
  for (let j = i + 1; j <= i + max && j < lineas.length; j++) {
    const t = limpiar(lineas[j]);
    if (t) return t;
  }
  return null;
}

const usd = (s) => {
  const m = /USD\s?([\d.,]+)/i.exec(s ?? '');
  if (!m) return null;
  const n = Number(m[1].replace(/\./g, '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

function parseGrado(md, url, nivel) {
  const lineas = md.split('\n');
  const iTitulo = lineas.findIndex((l) => /^#\s+\S/.test(l));
  const nombre = iTitulo >= 0 ? limpiar(lineas[iTitulo].replace(/^#\s+/, '')) : null;

  // La línea inmediatamente anterior al título es el "eyebrow" (ej. "Carver University · Maestría 100% en línea")
  let descripcion = null;
  for (let j = iTitulo + 1; j < Math.min(iTitulo + 6, lineas.length); j++) {
    const t = limpiar(lineas[j]);
    if (t && !/^\[/.test(lineas[j].trim()) && t.length > 60) { descripcion = t; break; }
  }

  const bloqueInversion = lineas.findIndex((l) => /^Programa completo/.test(limpiar(l)));
  let arancelUsd = null;
  let creditos = null;
  if (bloqueInversion >= 0) {
    const mc = /·\s*(\d+)\s*créditos/.exec(limpiar(lineas[bloqueInversion]));
    creditos = mc ? Number(mc[1]) : null;
    for (let j = bloqueInversion + 1; j < bloqueInversion + 6 && j < lineas.length; j++) {
      const v = usd(limpiar(lineas[j]));
      if (v != null) { arancelUsd = v; break; }
    }
  }

  const beca = (() => {
    const m = /Becas? de hasta (\d+)\s*%/i.exec(md);
    return m ? Number(m[1]) : null;
  })();

  const brochure = (/(https:\/\/uachile\.bitrix24\.es\/doc\/[A-Za-z0-9]+)/.exec(md) ?? [])[1] ?? null;

  const duracionTxt = (() => {
    const m = /Duración:\s*([^\n|]{1,40})/.exec(md);
    return m ? limpiar(m[1]) : null;
  })();

  return {
    nombre,
    url,
    tipo: nivel === 'pregrado' ? 'Licenciatura' : 'Maestría',
    nivel,
    creditos,
    arancelUsd,
    moneda: 'USD',
    duracion: duracionTxt, // las maestrías no declaran una duración fija: queda null a propósito
    modalidad: faq(lineas, /modalidad/i),
    requisitos: faq(lineas, /requisitos de admisión/i),
    dirigidoA: faq(lineas, /para quién está diseñado/i),
    planEstudios: faq(lineas, /cuántos créditos|asignaturas/i),
    becaMaxPct: beca,
    ayudaFinanciera: faq(lineas, /becas o ayuda financiera/i),
    descripcion,
    brochure,
  };
}

function parseCurso(md, url, nivel) {
  const lineas = md.split('\n');
  // Los "## \|" son restos de tablas del maquetador, no títulos: se descartan.
  const h2 = lineas
    .map((l, i) => ({ l, i }))
    .filter((x) => /^##\s+\S/.test(x.l) && limpiar(x.l.replace(/^##\s+/, '')).replace(/[|\s]/g, '') !== '');
  const nombre = h2.length ? limpiar(h2[0].l.replace(/^##\s+/, '')) : null;
  // La descripción es el primer ## distinto del nombre (el nombre viene repetido 2 veces)
  let descripcion = null;
  for (const x of h2) {
    const t = limpiar(x.l.replace(/^##\s+/, ''));
    if (t && t !== nombre && !/formulario/i.test(t)) { descripcion = t; break; }
  }

  const objetivos = [];
  const iObj = lineas.findIndex((l) => /Objetivos del aprendizaje/i.test(l));
  if (iObj >= 0) {
    for (let j = iObj + 1; j < lineas.length; j++) {
      const raw = lineas[j].trim();
      if (/^-\s+/.test(raw)) objetivos.push(limpiar(raw.replace(/^-\s+/, '')));
      else if (objetivos.length && raw && !/^\s*$/.test(raw) && !/^-/.test(raw)) break;
    }
  }

  return {
    nombre,
    url,
    tipo: nivel === 'noocs' ? 'NOOC (curso corto)' : 'Curso de educación continua',
    nivel,
    duracion: tras(lineas, /^Duración$/i),
    audiencia: tras(lineas, /^Audiencia objetiva$/i),
    valorUsd: usd(tras(lineas, /^Valor referencial$/i)),
    certificadoUsd: usd(tras(lineas, /^Emisión del certificado$/i)),
    moneda: 'USD',
    objetivos,
    descripcion,
  };
}

/** Los 2 cursos de educación continua usan otra maqueta: sin bloques "Valor referencial" —
 *  el precio vive en el FAQ ("El pago de USD 70 se realiza..."). */
function parseEduContinua(md, url) {
  const lineas = md.split('\n');
  const secc = (patron) => {
    const i = lineas.findIndex((l) => /^##\s/.test(l) && patron.test(l));
    if (i < 0) return null;
    for (let j = i + 1; j < lineas.length; j++) {
      if (/^#{1,6}\s/.test(lineas[j])) return null;
      const t = limpiar(lineas[j]);
      if (t) return t;
    }
    return null;
  };
  const nombre = limpiar(
    (lineas.find((l) => /^##\s+Curso de Educación Continua/i.test(l)) ?? '').replace(/^##\s+/, ''),
  ) || null;
  const mPago = /pago de USD\s?([\d.,]+)/i.exec(md);
  const mCert = /certificado tiene un costo de USD\s?([\d.,]+)/i.exec(md);
  return {
    nombre,
    url,
    tipo: 'Curso de educación continua',
    nivel: 'continuingeducation',
    duracion: null, // la maqueta no la declara
    audiencia: secc(/a quién está dirigido/i),
    valorUsd: mPago ? Number(mPago[1].replace(/\./g, '')) : null,
    certificadoUsd: mCert ? Number(mCert[1].replace(/\./g, '')) : null,
    moneda: 'USD',
    objetivos: [],
    descripcion: secc(/Descripción del Programa/i),
    certificacion: secc(/^##\s*Certificación/i),
  };
}

const catalogo = {};
const faltantes = [];
for (const f of readdirSync(DIR).filter((x) => x.endsWith('.md'))) {
  const nivel = f.split('__')[0];
  const slug = f.replace(/\.md$/, '').split('__').slice(1).join('/');
  const url = `https://carver.university/es/programas-academicos/${nivel}/${slug}`;
  const md = readFileSync(`${DIR}/${f}`, 'utf8');
  const p =
    nivel === 'pregrado' || nivel === 'postgrado'
      ? parseGrado(md, url, nivel)
      : nivel === 'continuingeducation'
        ? parseEduContinua(md, url)
        : parseCurso(md, url, nivel);
  if (!p.nombre) { faltantes.push(`${f}: sin nombre`); continue; }
  if (catalogo[p.nombre]) faltantes.push(`${p.nombre}: nombre repetido (se pisa con ${f})`);
  catalogo[p.nombre] = p;
  // Avisa de campos clave vacíos para revisarlos a mano en vez de publicarlos en silencio
  const clave =
    nivel === 'pregrado' || nivel === 'postgrado'
      ? ['arancelUsd', 'creditos', 'requisitos']
      : nivel === 'continuingeducation'
        ? ['valorUsd']
        : ['valorUsd', 'duracion'];
  for (const c of clave) if (p[c] == null) faltantes.push(`${p.nombre}: falta ${c}`);
}

writeFileSync(OUT, JSON.stringify(catalogo, null, 2) + '\n', 'utf8');
console.log(`programas: ${Object.keys(catalogo).length} → ${OUT}`);
if (faltantes.length) {
  console.log(`\n⚠ campos sin dato (${faltantes.length}) — revisar a mano:`);
  for (const x of faltantes) console.log('  ·', x);
} else {
  console.log('\nsin campos clave vacíos');
}
