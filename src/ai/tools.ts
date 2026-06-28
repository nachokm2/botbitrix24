// Definición de herramientas en formato Anthropic Messages API.
export const tools = [
  {
    name: 'consultar_programas',
    description:
      'Consulta el catálogo oficial de programas de postgrado de la Universidad Autónoma de Chile. ' +
      'Úsala SIEMPRE antes de informar sobre programas; nunca inventes nombres, duraciones ni modalidades.',
    input_schema: {
      type: 'object',
      properties: {
        area: { type: 'string', enum: ['negocios', 'salud', 'educacion', 'ingenieria', 'derecho'] },
        modalidad: { type: 'string', enum: ['online', 'presencial', 'semipresencial'] },
        texto: { type: 'string', description: 'Búsqueda libre por nombre o tema' },
      },
      required: [],
    },
  },
  {
    name: 'crear_lead_crm',
    description:
      'Crea un lead en el CRM con los datos del interesado. Úsala cuando tengas al menos el nombre y un dato de ' +
      'contacto (teléfono o email), idealmente con el programa de interés.',
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string' },
        telefono: { type: 'string' },
        email: { type: 'string' },
        programa_interes: { type: 'string' },
        comentario: { type: 'string' },
      },
      required: ['nombre'],
    },
  },
  {
    name: 'escalar_a_humano',
    description:
      'Deriva la conversación a un asesor humano. Úsala si el cliente lo pide, si hay intención alta de matrícula, ' +
      'o si la consulta excede tu alcance (precios, becas, fechas que no tienes).',
    input_schema: {
      type: 'object',
      properties: {
        motivo: { type: 'string' },
      },
      required: ['motivo'],
    },
  },
] as const;
