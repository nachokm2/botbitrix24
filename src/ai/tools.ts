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
    name: 'consultar_condiciones_comerciales',
    description:
      'Devuelve el PRECIO REAL de un programa (arancel con el descuento institucional YA aplicado, matrícula y ' +
      'total a pagar) y las condiciones de pago Toku (cuotas). Úsala SIEMPRE que el prospecto pregunte por precio, ' +
      'descuento, "cuánto sale en total", cuotas o financiamiento. NO cotices con el arancel de detalle_programa: ' +
      'ese es el precio de LISTA sin descuento. Pásale el nombre del programa; si existe en varias sedes ' +
      '(Santiago/Temuco) con el mismo nombre, agrega "sede". Si el programa no cotiza (nuevo/suspendido) o no se ' +
      'encuentra, la herramienta te lo indica para que derives; nunca inventes montos.',
    input_schema: {
      type: 'object',
      properties: {
        programa: { type: 'string', description: 'Nombre del programa (ej. "Magíster en Marketing Digital").' },
        sede: { type: 'string', enum: ['Santiago', 'Temuco'], description: 'Solo si el programa existe en varias sedes.' },
      },
      required: ['programa'],
    },
  },
  {
    name: 'registrar_interes_crm',
    description:
      'Guarda/actualiza en el CRM los datos del cliente que vayas capturando: actualiza el CONTACTO ' +
      '(nombre, apellido, email, teléfono) y el DEAL (programa de interés) vinculados a la conversación, y deja ' +
      'una nota. Llámala apenas tengas datos nuevos (no esperes a tenerlos todos); puedes llamarla varias veces ' +
      'a medida que el cliente los entrega. El email y el teléfono se agregan a la ficha sin borrar los existentes.',
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string' },
        apellido: { type: 'string' },
        email: { type: 'string', description: 'Correo electrónico del cliente; se agrega/actualiza en su contacto.' },
        telefono: {
          type: 'string',
          description: 'Teléfono de contacto que entregue el cliente; se agrega a su ficha (no reemplaza el de WhatsApp).',
        },
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
    name: 'solicitar_llamada',
    description:
      'Dispara una llamada telefónica INMEDIATA de nuestra asistente de voz al cliente. Úsala SOLO cuando el cliente ' +
      'ACEPTA explícitamente que lo llamemos por teléfono. Antes de llamarla, confirma con el cliente el número al que ' +
      'llamar (formato chileno, ej. +56 9 1234 5678) y pásalo en "telefono". Tras usarla, dile que recibirá la llamada ' +
      'en unos momentos. No la uses si el cliente no ha aceptado la llamada.',
    input_schema: {
      type: 'object',
      properties: {
        telefono: {
          type: 'string',
          description: 'Teléfono del cliente en formato E.164 (ej. +56912345678), ya confirmado con él.',
        },
        motivo: { type: 'string', description: 'Breve contexto de por qué se llama (opcional, para el registro).' },
      },
      required: ['telefono'],
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
  {
    // Solo la habilita el perfil de VOZ (VOICE_PROFILE.toolNames). En chat se usa escalar_a_humano.
    name: 'transferir_a_asesor',
    description:
      'Deriva la LLAMADA en curso a un asesor humano. Úsala si el cliente lo pide, si hay intención alta de ' +
      'matrícula, o si la consulta excede tu alcance. Devuelve el asesor asignado (si lo hay) y el destino; ' +
      'nombra al asesor solo si la herramienta lo entrega, nunca lo inventes.',
    input_schema: {
      type: 'object',
      properties: {
        motivo: { type: 'string' },
      },
      required: ['motivo'],
    },
  },
  {
    // Solo la habilita el perfil de VOZ SALIENTE (VOICE_OUTBOUND_MMD). Marca al prospecto como NO interesado.
    name: 'marcar_no_interesado',
    description:
      'Registra que el prospecto NO tiene interés en el programa. Úsala cuando lo diga de forma clara, o cuando ' +
      'pida expresamente que no lo vuelvan a contactar (en ese caso usa motivo "opt-out"). Deja registrado el ' +
      'motivo para el asesor y detiene futuras llamadas de la campaña. Tras usarla, agradece y cierra cordialmente.',
    input_schema: {
      type: 'object',
      properties: {
        motivo: {
          type: 'string',
          description: 'Motivo breve (ej. "no le interesa", "ya se matriculó en otra parte", "opt-out" si pide no ser contactado).',
        },
      },
      required: ['motivo'],
    },
  },
  {
    // Solo VOZ SALIENTE. Quien contestó NO es el titular del prospecto que buscábamos.
    name: 'marcar_no_titular',
    description:
      'Registra que quien contestó NO es la persona que buscábamos (otro familiar, número equivocado, etc.). ' +
      'Úsala tras confirmar la identidad al inicio de la llamada. Si te indican un mejor horario o número, inclúyelo.',
    input_schema: {
      type: 'object',
      properties: {
        detalle: { type: 'string', description: 'Detalle opcional: mejor horario para llamar, número correcto, o quién contestó.' },
      },
      required: [],
    },
  },
  {
    // Solo VOZ SALIENTE. Deja registrada una objeción para el asesor y la reportería; NO corta la llamada.
    name: 'registrar_objecion',
    description:
      'Registra una objeción o duda relevante que plantee el prospecto (precio, tiempo, "lo tengo que pensar", ' +
      'financiamiento, etc.) para que el asesor la conozca. Puedes llamarla varias veces. NO detiene la llamada: ' +
      'sigue conversando y manejando la objeción con normalidad.',
    input_schema: {
      type: 'object',
      properties: {
        objecion: {
          type: 'string',
          enum: ['precio', 'tiempo', 'lo_va_a_pensar', 'consultar_con_otro', 'financiamiento', 'modalidad', 'otra'],
        },
        detalle: { type: 'string', description: 'Lo que dijo el prospecto, en breve.' },
      },
      required: ['objecion'],
    },
  },
  {
    // Solo VOZ SALIENTE. El prospecto pide que lo llamen en otro momento.
    name: 'agendar_callback',
    description:
      'Registra que el prospecto pide ser llamado en otro momento. Úsala cuando indique una hora/día preferido o ' +
      'diga que ahora no puede hablar. Confirma con él la hora antes de usarla. La campaña reprogramará el intento.',
    input_schema: {
      type: 'object',
      properties: {
        cuando: {
          type: 'string',
          description: 'Momento pedido, en palabras del prospecto (ej. "mañana en la tarde", "el viernes a las 5").',
        },
        telefono: { type: 'string', description: 'Número alternativo, si entrega uno distinto (opcional).' },
      },
      required: ['cuando'],
    },
  },
] as const;
