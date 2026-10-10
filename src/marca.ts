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
  /** Nombre con el que el bot HABLA (y con el que se presenta si no hay asesor que adoptar). */
  botNombre: string;
  /** Nombre con el que queda REGISTRADO en Bitrix (imbot.register PROPERTIES.NAME). Se separa de
   *  botNombre porque las dos marcas comparten portal y ambas llamaban a su bot "Sofía": en el
   *  desplegable de configuración del canal aparecían dos entradas idénticas y elegir la equivocada
   *  mandaba el canal de una marca al bot de la otra. */
  botNombreRegistro: string;
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
  /** Valores válidos del filtro "tipo" de consultar_programas. DEBEN coincidir con los del catálogo
   *  de la marca: el enum del esquema es lo único que el modelo ve, así que si ofrece un tipo que el
   *  catálogo no usa, la búsqueda devuelve cero en silencio y el bot responde que no hay programas
   *  (pasó en la primera prueba de Carver: el esquema solo ofrecía "magister" y el catálogo de
   *  Carver usa "maestria"). */
  tiposPrograma: string[];
  /** Facultades para el filtro del mismo nombre. Vacío = la marca no clasifica por facultad y el
   *  filtro NO se ofrece (Carver: sus 38 programas no tienen facultad). */
  facultades: string[];
  /** ¿El bot se presenta con el NOMBRE DEL ASESOR dueño de la negociación en vez del suyo propio?
   *  Carver atiende así: el cliente habla desde el primer mensaje con el nombre de quien después va
   *  a seguir el caso. Si no hay un responsable resoluble (chat sin negociación todavía), cae al
   *  nombre del bot. Postgrados se presenta siempre como Sofía. */
  sePresentaComoAsesor: boolean;
  /** ¿Expone los canales de webchat y redes (Instagram/Messenger) además de WhatsApp? Carver es
   *  SOLO WhatsApp: dejar vivos esos endpoints en su servicio significaba superficie pública sin uso
   *  y, peor, respondiendo con la identidad de Postgrados — sus prompts no están parametrizados por
   *  marca y dicen "Universidad Autónoma de Chile". */
  otrosCanales: boolean;
  /** Nombre corto para el ítem de menú del panel dentro de Bitrix24. Ambas marcas comparten portal,
   *  así que el título no puede ser fijo o quedan dos entradas idénticas. */
  etiquetaPanel: string;
  /** Descripción de consultar_programas: qué catálogo es. La genérica hablaba siempre de postgrados
   *  de la Universidad Autónoma, lo que para otra marca es sencillamente falso. */
  catalogoDescripcion: string;
};

const POSTGRADOS: Marca = {
  key: 'postgrados',
  botNombre: 'Sofía',
  botNombreRegistro: 'Sofía · Postgrados UA',
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
  sePresentaComoAsesor: false,
  otrosCanales: true,
  etiquetaPanel: 'Postgrados',
  tiposPrograma: ['magister', 'diplomado', 'especialidad'],
  facultades: [
    'Administración y Negocios',
    'Arquitectura, Construcción y Medio Ambiente',
    'Ciencias de la Salud',
    'Ciencias Sociales y Humanidades',
    'Derecho',
    'Educación',
    'Ingeniería',
    'Odontología',
  ],
  catalogoDescripcion:
    'Consulta el catálogo oficial de programas de postgrado de la Universidad Autónoma de Chile ' +
    '(magísteres, diplomados y especialidades médicas/odontológicas).',
};

const CARVER: Marca = {
  key: 'carver',
  botNombre: 'Sofía',
  botNombreRegistro: 'Sofía · Carver',
  botCargo: 'Asesora de Admisión de Carver University',
  organizacion: 'Carver University',
  espanol: 'español neutro latinoamericano (atiendes a Chile, Perú, Ecuador, Colombia y República Dominicana: no uses chilenismos ni modismos de un solo país)',
  ofertaResumen:
    'Hay 3 licenciaturas, 13 maestrías y 22 cursos cortos (NOOCs y educación continua). TODOS los programas son 100% en línea, con clases en vivo en español, y los valores están en DÓLARES (USD). Usa "consultar_programas" para buscar/filtrar por tipo (licenciatura/maestria/curso) o tema.',
  catalogo: 'carver',
  // Los "dos precios" del sitio eran Regular vs Upgrade y las tres formas de pago. Con la planilla
  // validada por la dirección (ver scripts/build-carver-precios.ts) ya hay una fuente única.
  cotiza: true,
  usaPlanillaComercial: true,
  tieneVoz: false,
  capturaDocumentos: false,
  sePresentaComoAsesor: true,
  otrosCanales: false,
  etiquetaPanel: 'Carver',
  tiposPrograma: ['licenciatura', 'maestria', 'curso'],
  facultades: [], // los 38 programas de Carver no están clasificados por facultad
  catalogoDescripcion:
    'Consulta el catálogo oficial de programas de Carver University: licenciaturas, maestrías y ' +
    'cursos cortos (NOOCs y educación continua), todos 100% en línea con clases en vivo en español.',
};

const MARCAS: Record<MarcaKey, Marca> = { postgrados: POSTGRADOS, carver: CARVER };

function resolver(): Marca {
  const key = String(process.env.MARCA ?? 'postgrados').trim().toLowerCase();
  return MARCAS[key as MarcaKey] ?? POSTGRADOS;
}

export const marca: Marca = resolver();
