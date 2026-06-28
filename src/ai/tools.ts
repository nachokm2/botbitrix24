// Definición de herramientas en formato Anthropic Messages API.
export const tools = [
  {
    name: 'consultar_programas',
    description:
      'Consulta el catálogo oficial de programas de postgrado de la Universidad Autónoma de Chile ' +
      '(magísteres y doctorados). Úsala SIEMPRE antes de informar sobre programas; nunca inventes ' +
      'nombres, facultades, duraciones, modalidades ni URLs. Devuelve la URL oficial de cada programa.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: ['magister', 'doctorado'] },
        facultad: {
          type: 'string',
          enum: [
            'Administración y Negocios',
            'Arquitectura, Construcción y Medio Ambiente',
            'Ciencias de la Salud',
            'Ciencias Sociales y Humanidades',
            'Derecho',
            'Educación',
            'Ingeniería',
          ],
        },
        modalidad: { type: 'string', enum: ['online', 'presencial'] },
        texto: { type: 'string', description: 'Búsqueda libre por nombre o tema (ej. "MBA", "inteligencia artificial")' },
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
