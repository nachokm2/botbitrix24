// Definición de herramientas en formato Anthropic Messages API.
export const tools = [
  {
    name: 'consultar_programas',
    description:
      'Consulta el catálogo oficial de programas de postgrado de la Universidad Autónoma de Chile ' +
      '(magísteres, diplomados y especialidades médicas/odontológicas). Úsala SIEMPRE antes de informar ' +
      'sobre programas; nunca inventes nombres, facultades, duraciones, modalidades ni URLs. Devuelve la ' +
      'URL oficial de cada programa.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: ['magister', 'diplomado', 'especialidad'] },
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
            'Odontología',
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
      'Guarda en el CRM los datos del cliente que vayas capturando: actualiza el CONTACTO (nombre, apellido, email) ' +
      'y el DEAL (programa de interés) vinculados a la conversación, y deja una nota. Llámala apenas tengas datos ' +
      'nuevos (no esperes a tenerlos todos); puedes llamarla varias veces a medida que el cliente los entrega.',
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string' },
        apellido: { type: 'string' },
        email: { type: 'string' },
        telefono: { type: 'string', description: 'Solo si el cliente da un teléfono distinto al de WhatsApp' },
        rut: { type: 'string' },
        programa_interes: {
          type: 'string',
          description:
            'Nombre del programa que más le interesa al cliente AHORA. Si durante la conversación cambia de ' +
            'opinión o se enfoca en otro programa, vuelve a llamar la herramienta con el programa actualizado ' +
            '(se sobrescribe el campo en el CRM). Usa el nombre exacto del catálogo cuando lo tengas.',
        },
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
