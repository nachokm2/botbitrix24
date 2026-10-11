import type { CasoRegresion } from './regresion';

/**
 * Los casos vienen de conversaciones REALES del piloto, reescritas sin datos personales. Cada uno
 * dejó un defecto en producción; la comprobación es la garantía de que ese defecto no vuelve.
 *
 * Al agregar un caso nuevo, lo importante es `origen`: dentro de un año, lo que hace entendible una
 * comprobación rara es saber qué conversación la motivó.
 */

export const CASOS_COMUNES: CasoRegresion[] = [
  {
    nombre: 'no vuelve a pedir el nombre cuando ya lo dieron',
    origen: 'Conversación donde el bot pidió el nombre cuatro veces seguidas pese a tenerlo.',
    mensajes: [
      'Hola, soy Camila Rojas, quiero información de un magíster',
      'Me interesa el de gestión educativa',
      '¿Y cuánto dura?',
    ],
    comprobaciones: [{ tipo: 'no_pide_dato', dato: 'nombre' }, { tipo: 'no_respuesta_vacia' }],
  },
  {
    nombre: 'responde sobre el programa que la persona nombró',
    origen: 'La persona mostró interés en psicología y el bot no le dio información del programa.',
    mensajes: ['Hola', 'Quiero saber del magíster en psicología'],
    comprobaciones: [{ tipo: 'menciona', texto: 'psicolog' }, { tipo: 'no_respuesta_vacia' }],
  },
  {
    nombre: 'no inventa precios: los saca de la planilla',
    origen: 'El precio es el dato que más caro sale equivocado.',
    mensajes: ['Hola, cuánto cuesta el magíster en gestión educativa'],
    comprobaciones: [{ tipo: 'precio_viene_de_la_planilla' }, { tipo: 'no_respuesta_vacia' }],
  },
  {
    nombre: 'deriva cuando piden hablar con una persona y ya hay datos',
    origen: 'Tres de tres escalamientos explícitos no llegaron a enviarse (deal #3490143 y siguientes).',
    // Con los datos incompletos el bot NO debe derivar —es la política del prompt, para que el asesor
    // no reciba un caso sin cómo contactarlo—, así que el caso los entrega antes de pedir un asesor.
    mensajes: [
      'Hola, soy Camila Rojas, me interesa el magíster en gestión educativa',
      'Mi correo es camila.rojas@ejemplo.cl y mi teléfono +56912345678',
      'Prefiero que me contacte un asesor, por favor',
    ],
    comprobaciones: [{ tipo: 'deriva' }, { tipo: 'no_respuesta_vacia' }],
  },
  {
    nombre: 'actualiza el programa cuando la conversación cambia de rumbo',
    origen: 'La ficha quedaba con el primer programa nombrado aunque la conversación girara sobre otro.',
    mensajes: [
      'Hola, me interesa el magíster en gestión educativa',
      'Mejor cuéntame del de psicología, ese me llama más la atención',
      '¿Y cuánto cuesta ese?',
    ],
    comprobaciones: [{ tipo: 'programa_de_interes', programa: 'psicolog' }],
  },
  {
    nombre: 'no contesta con un muro de texto',
    origen: '"Este mensaje es demasiado extenso para la persona, debe ser breve y conciso."',
    mensajes: ['Hola, qué magísteres tienen?'],
    comprobaciones: [{ tipo: 'largo_maximo', caracteres: 1200 }, { tipo: 'no_respuesta_vacia' }],
  },
  {
    nombre: 'una consulta suelta no se deriva sola',
    origen: 'Derivar cada consulta llenaría de pendientes a los asesores y restaría valor a las reales.',
    mensajes: ['Hola, ustedes tienen programas online?'],
    comprobaciones: [{ tipo: 'no_deriva' }],
  },
];

/** Carver es solo WhatsApp: ofrecer una llamada promete algo que no existe. */
export const CASOS_CARVER: CasoRegresion[] = [
  {
    nombre: 'no ofrece llamarte por teléfono',
    origen: 'Carver atiende solo por WhatsApp; el prompt se lo prohíbe y conviene vigilarlo.',
    mensajes: ['Hola, quiero información', 'Prefiero que me expliquen bien todo'],
    comprobaciones: [{ tipo: 'no_ofrece_llamada' }, { tipo: 'no_respuesta_vacia' }],
  },
];

export function casosDeMarca(marcaKey: string): CasoRegresion[] {
  return marcaKey === 'carver' ? [...CASOS_COMUNES, ...CASOS_CARVER] : CASOS_COMUNES;
}
