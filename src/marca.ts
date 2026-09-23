// Identidad de la MARCA que atiende: todo lo que cambia entre una institución y otra sin que cambie
// la lógica del bot (nombre visible, organización, resumen de la oferta, catálogo, si puede cotizar).
// Se elige con MARCA; el default es 'postgrados', así que sin esa variable NADA cambia respecto de lo
// que ya corre en marcha blanca. Un segundo servicio (ver docs) levanta el mismo código con MARCA=carver.
//
// Ojo: esto NO es multi-marca dentro de un mismo proceso — el estado del app (auth + botId) es uno solo
// (ver store.ts), así que cada marca necesita su propio deployment, con su propio Redis y Postgres.

export type MarcaKey = 'postgrados' | 'carver';

export type Marca = {
  key: MarcaKey;
  /** Nombre visible del bot en Open Lines (imbot.register PROPERTIES.NAME). */
  botNombre: string;
  /** Cargo visible junto al nombre en el chat. */
  botCargo: string;
  /** Cómo se presenta en el prompt: "Eres {botNombre}, asesora comercial de {organizacion}." */
  organizacion: string;
  /** Variante de español que habla. Carver atiende a varios países, no solo Chile. */
  espanol: string;
  /** Primer bullet del bloque "SOBRE LA OFERTA": qué se vende y cómo buscarlo. */
  ofertaResumen: string;
  /** Qué catálogo cargan ai/catalog.ts y ai/detalles.ts. */
  catalogo: MarcaKey;
  /** ¿El bot puede cotizar por su cuenta? Si es false, deriva a un asesor cuando preguntan precio
   *  (Carver: hasta que la institución confirme qué precio es el vigente — el sitio muestra dos). */
  cotiza: boolean;
  /** ¿Existe la planilla comercial (core/condicionesComerciales) que decide qué se puede ofrecer?
   *  Solo Postgrados la tiene. Si es false, consultar_programas NO filtra por ella — si filtrara,
   *  dejaría el catálogo en cero, porque ningún programa de otra marca está en esa planilla. */
  usaPlanillaComercial: boolean;
  /** ¿Tiene agente de voz propio (Vapi)? Si es false, el bot NO ofrece llamar: el asistente de voz
   *  configurado es el de Postgrados y hablaría de la oferta equivocada. */
  tieneVoz: boolean;
  /** ¿Pide antecedentes de matrícula (profesión, dirección, foto de cédula)? El campo de cédula del
   *  CRM es "Cedula de identidad CL" y el flujo es el de Postgrados; Carver es multipaís. */
  capturaDocumentos: boolean;
};

const POSTGRADOS: Marca = {
  key: 'postgrados',
  botNombre: 'Sofía',
  botCargo: 'Asesora de Admisión de Postgrados',
  organizacion: 'la Universidad Autónoma de Chile (unidad de Postgrados)',
  espanol: 'español de Chile',
  ofertaResumen:
    'Hay ~47 magísteres, ~128 diplomados y 9 especialidades (médicas y odontológicas). La mayoría de magísteres/diplomados son ONLINE; las especialidades médicas/odontológicas suelen ser PRESENCIALES. Usa "consultar_programas" para buscar/filtrar por tipo (magister/diplomado/especialidad), facultad, modalidad o tema.',
  catalogo: 'postgrados',
  cotiza: true,
  usaPlanillaComercial: true,
  tieneVoz: true,
  capturaDocumentos: true,
};

const CARVER: Marca = {
  key: 'carver',
  botNombre: 'Sofía',
  botCargo: 'Asesora de Admisión de Carver University',
  organizacion: 'Carver University',
  espanol: 'español neutro latinoamericano (atiendes a Chile, Perú, Ecuador, Colombia y República Dominicana: no uses chilenismos ni modismos de un solo país)',
  ofertaResumen:
    'Hay 3 licenciaturas, 13 maestrías y 22 cursos cortos (NOOCs y educación continua). TODOS los programas son 100% en línea, con clases en vivo en español, y los valores están en DÓLARES (USD). Usa "consultar_programas" para buscar/filtrar por tipo (licenciatura/maestria/curso) o tema.',
  catalogo: 'carver',
  cotiza: false, // el sitio publica dos precios distintos por programa: no cotizar hasta que Carver confirme
  usaPlanillaComercial: false,
  tieneVoz: false,
  capturaDocumentos: false,
};

const MARCAS: Record<MarcaKey, Marca> = { postgrados: POSTGRADOS, carver: CARVER };

function resolver(): Marca {
  const key = String(process.env.MARCA ?? 'postgrados').trim().toLowerCase();
  return MARCAS[key as MarcaKey] ?? POSTGRADOS;
}

export const marca: Marca = resolver();
