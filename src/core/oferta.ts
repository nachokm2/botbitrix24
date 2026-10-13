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

export const MENSAJE_NO_COMERCIALIZABLE =
  'Este programa NO forma parte de la oferta que se atiende por este canal. No lo ofrezcas, no lo ' +
  'cotices ni des detalles de él. Dilo con naturalidad en una frase y ofrece las licenciaturas y ' +
  'maestrías disponibles que se relacionen con lo que busca la persona.';
