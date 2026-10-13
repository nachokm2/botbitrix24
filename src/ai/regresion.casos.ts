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

// Reglas que valen en TODA conversación de Carver: se suman a las comprobaciones propias de cada caso.
const BASE_CARVER: CasoRegresion['comprobaciones'] = [
  { tipo: 'no_respuesta_vacia' },
  { tipo: 'fee_solo_si_preguntan' },
  { tipo: 'no_ofrece_nooc' },
  { tipo: 'sin_markdown' },
  { tipo: 'no_repite' },
  { tipo: 'no_inventa_fechas' },
  { tipo: 'brochure_verificado' },
  { tipo: 'largo_maximo', caracteres: 900 },
];

const ref = (c: CasoRegresion): CasoRegresion => ({ ...c, comprobaciones: [...BASE_CARVER, ...c.comprobaciones] });

/**
 * Conversaciones de REFERENCIA de la auditoría del piloto de Carver (octubre 2026). Son las doce
 * situaciones mínimas que el bot debe resolver bien, con las mismas condiciones antes y después de
 * cada cambio. Se reconstruyen de conversaciones reales del piloto, sin datos personales.
 */
export const CASOS_REFERENCIA_CARVER: CasoRegresion[] = [
  ref({
    nombre: 'R01 prospecto que conoce su programa',
    origen: 'chat del piloto: "Maestría inteligencia artificial" → "Precio y contenido" (respuesta con negritas y fee).',
    mensajes: ['Hola, quiero información de la Maestría en Inteligencia Artificial', '¿Cuánto cuesta?'],
    comprobaciones: [
      { tipo: 'menciona', texto: 'inteligencia artificial' },
      { tipo: 'precio_viene_de_la_planilla' },
      { tipo: 'no_pregunta_modalidad' },
      { tipo: 'preguntas_por_respuesta', maximo: 1 },
      { tipo: 'identidad_coherente' },
    ],
  }),
  ref({
    nombre: 'R02 prospecto que todavía no decide',
    origen: 'Inicio de conversación con preguntas no pertinentes (modalidad, cuando todo es en línea).',
    mensajes: ['Hola, quiero estudiar algo pero no sé qué', 'Trabajo en recursos humanos en una empresa'],
    comprobaciones: [
      { tipo: 'no_pregunta_modalidad' },
      { tipo: 'preguntas_por_respuesta', maximo: 1 },
      { tipo: 'no_deriva' },
      { tipo: 'identidad_coherente' },
    ],
  }),
  ref({
    nombre: 'R03 dudas sobre admisión',
    origen: 'Un asesor dio una fecha de inicio que no está en ninguna fuente verificada del bot.',
    mensajes: ['¿Qué requisitos piden para la Maestría en Psicología?', '¿Y cuándo empiezan las clases?'],
    comprobaciones: [{ tipo: 'menciona', texto: 'requisit' }, { tipo: 'preguntas_por_respuesta', maximo: 1 }],
  }),
  ref({
    nombre: 'R04 pregunta por el fee de titulación',
    origen: 'El fee de titulación (USD 125) se mencionaba en cada cotización sin que nadie lo preguntara.',
    mensajes: ['¿Cuánto cuesta la Maestría en Salud Mental?', '¿Hay que pagar algo por la titulación al terminar?'],
    comprobaciones: [{ tipo: 'precio_viene_de_la_planilla' }, { tipo: 'menciona', texto: '125' }],
  }),
  ref({
    nombre: 'R05 pide el brochure',
    origen: 'El bot entregó como brochure un visor HTML en el dominio de otra institución, sin verificarlo.',
    mensajes: ['Hola, ¿me puede enviar el brochure de la Maestría en Administración Pública?'],
    comprobaciones: [{ tipo: 'no_deriva' }],
  }),
  ref({
    nombre: 'R06 cliente que ya entregó sus datos',
    origen: '"¿Por qué me pides mi nombre si lo debes tener?" — un cliente real.',
    contexto: { datosConocidos: { nombre: 'Andrea Molina', email: 'andrea.molina@ejemplo.com', telefono: '+51987654321' } },
    mensajes: ['Hola, me interesa la Maestría en Neurodivergencia', 'Quiero que me contacten para inscribirme'],
    comprobaciones: [
      { tipo: 'no_pide_dato', dato: 'nombre' },
      { tipo: 'no_pide_dato', dato: 'email' },
      { tipo: 'no_pide_dato', dato: 'telefono' },
      { tipo: 'deriva' },
    ],
  }),
  ref({
    nombre: 'R07 repite una pregunta',
    origen: 'Mensajes largos que repetían el mismo bloque de precios y la misma pregunta de cierre.',
    mensajes: ['¿Cuánto cuesta la Maestría en Ingeniería?', 'Perdón, ¿cuánto era el valor?'],
    comprobaciones: [{ tipo: 'precio_viene_de_la_planilla' }],
  }),
  ref({
    nombre: 'R08 estudiante matriculado con un inconveniente',
    origen: 'Estudiantes con problemas de plataforma recibían el flujo de venta en vez de su Advisor.',
    contexto: {
      estudiante: {
        ok: true,
        matriculado: true,
        programa: 'Maestría en Psicología',
        advisor: { nombre: 'Daniela Cáceres', email: 'daniela.caceres@carver.university', verificado: true },
      },
    },
    mensajes: ['Hola, soy estudiante de la maestría y no puedo entrar a la plataforma de clases'],
    comprobaciones: [{ tipo: 'menciona', texto: 'daniela.caceres@carver.university' }, { tipo: 'no_pide_dato', dato: 'email' }],
  }),
  ref({
    nombre: 'R09 lead asignado a un asesor específico',
    origen: 'El bot hablaba como "Ignacio" y a la vez decía "confírmelo con Ignacio".',
    contexto: { identidadAsesor: { nombre: 'Ignacio Ribera' } },
    mensajes: ['Hola, me interesa la Maestría en Administración de Empresas MBA', '¿Existe algún descuento si hago dos maestrías?'],
    comprobaciones: [{ tipo: 'identidad_coherente', nombre: 'Ignacio Ribera' }],
  }),
  ref({
    nombre: 'R10 lead sin asignación válida',
    origen: 'Sin asesor resoluble el bot se presentaba como "Sofía", otra identidad distinta a la del asesor.',
    contexto: { identidadAsesor: null },
    mensajes: ['Hola', 'Quiero información de la Licenciatura en Psicología'],
    comprobaciones: [{ tipo: 'identidad_coherente' }, { tipo: 'no_pregunta_modalidad' }],
  }),
  ref({
    nombre: 'R11 Bitrix24 no disponible',
    origen: 'Escrituras al CRM que fallan: el bot no debe afirmar que dejó algo registrado.',
    contexto: { crmCaido: true },
    mensajes: ['Hola, me interesa la Maestría en Salud Mental. Soy Carla Núñez, mi correo es carla.nunez@ejemplo.com'],
    comprobaciones: [{ tipo: 'no_afirma_registro_fallido' }],
  }),
  ref({
    nombre: 'R12 programa no autorizado para comercialización',
    origen: 'El bot ofrecía NOOCs gratuitos, que no forman parte de la oferta comercial autorizada.',
    mensajes: ['Hola, ¿tienen cursos gratis? Me interesa el de Hacking ético'],
    comprobaciones: [{ tipo: 'identidad_coherente' }],
  }),
];

export function casosDeMarca(marcaKey: string): CasoRegresion[] {
  return marcaKey === 'carver' ? [...CASOS_COMUNES, ...CASOS_CARVER, ...CASOS_REFERENCIA_CARVER] : CASOS_COMUNES;
}
