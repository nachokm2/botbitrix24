import { marca } from '../marca';

/**
 * Oferta COMERCIAL autorizada: qué tipos de programa puede ofrecer, cotizar o recomendar el bot.
 *
 * Es distinto del catálogo. El catálogo de Carver conserva sus 38 programas —incluidos los 22 cursos
 * cortos (NOOCs y educación continua)— porque es información histórica y de referencia que no se
 * borra. Pero la oferta que se vende por este canal son solo licenciaturas y maestrías: los NOOCs se
 * ofrecían igual, como "cursos gratis", y competían con los programas que sí se comercializan.
 *
 * El filtro se aplica en las herramientas (búsqueda, detalle, precio, brochure), no en el prompt:
 * lo que el modelo no ve, no lo puede ofrecer.
 */
export function esTipoComercializable(tipo: string | undefined | null): boolean {
  if (!marca.tiposComercializables.length) return true;
  return !!tipo && marca.tiposComercializables.includes(tipo);
}

/**
 * El primer programa nombrado en un texto que NO está en la oferta, o null. Lo usa el control de los
 * recordatorios: tomaban el nombre del programa del CRM o de una plantilla de marketing y ofrecían
 * "Diplomado en Salud Mental y Psiquiatría" o "Licenciatura en Educación Física", que no existen
 * (chats 1044703, 1476745 y 1583405). `existe` dice si un nombre está en el catálogo vendible.
 */
export function programaFueraDeOferta(texto: string, existe: (nombre: string) => boolean): string | null {
  // Sin "curso": "los cursos de Coursera" es un beneficio que sí se ofrece. Solo cuenta un NOMBRE: lo
  // que sigue a "en" o "de" con mayúscula ("Maestría en Ergonomía"), con sus conectores en minúscula
  // ("Pruebas en el Proceso Penal y Litigación"). "La maestría en este momento" o "su licenciatura de
  // base" no nombran ningún programa.
  const MAY = '[A-ZÁÉÍÓÚÑ][\\wáéíóúñü]*';
  const re = new RegExp(
    `\\b([Dd]iplomados?|[Dd]octorado|[Ll]icenciatura|[Mm]aestr[ií]a|[Mm][aá]ster|[Mm]ag[ií]ster)\\s+(?:en|de)\\s+(${MAY}(?:\\s+(?:(?:y|e|de|del|la|las|el|los|en|para|con|a)\\s+)*${MAY})*)`,
    'g',
  );
  for (const m of String(texto ?? '').matchAll(re)) {
    const tipo = m[1].toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const nombre = m[0].trim();
    const vendible = /^(licenciatura|maestria|master|magister)$/.test(tipo);
    // Un diplomado, un curso o un doctorado no se venden por este canal, se llamen como se llamen.
    if (!vendible && marca.tiposComercializables.length) return nombre;
    if (vendible && !existe(nombre)) return nombre;
  }
  return null;
}

export const MENSAJE_NO_COMERCIALIZABLE =
  'Este programa NO forma parte de la oferta que se atiende por este canal. No lo ofrezcas, no lo ' +
  'cotices ni des detalles de él. Dilo con naturalidad en una frase y ofrece las licenciaturas y ' +
  'maestrías disponibles que se relacionen con lo que busca la persona.';
