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
    name: 'detalle_programa',
    description:
      'Obtiene el detalle completo de UN programa: valores (arancel y matrícula), requisitos, descripción, ' +
      'objetivos, a quién va dirigido, malla por semestre, becas y brochure. Úsala cuando el usuario pregunte por ' +
      'un programa específico (precio, malla, requisitos, etc.). Pásale la "url" del programa (de consultar_programas) ' +
      'o su "nombre" exacto. No inventes estos datos: si el programa no tiene detalle cargado, deriva a un asesor.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL oficial del programa (de consultar_programas)' },
        nombre: { type: 'string', description: 'Nombre exacto del programa' },
      },
      required: [],
    },
  },
  {
    name: 'registrar_interes_crm',
    description:
      'Registra el interés del cliente en su ficha del CRM (la conversación ya está vinculada a su lead/contacto/deal). ' +
      'Deja una nota con el programa de interés y, si los tienes, actualiza nombre/teléfono/email. ' +
      'Úsala cuando hayas identificado el programa de interés y, idealmente, algún dato de contacto.',
    input_schema: {
      type: 'object',
      properties: {
        programa_interes: { type: 'string' },
        nombre: { type: 'string' },
        telefono: { type: 'string' },
        email: { type: 'string' },
        comentario: { type: 'string' },
      },
      required: [],
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
