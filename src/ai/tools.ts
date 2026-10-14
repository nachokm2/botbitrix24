// Definición de herramientas en formato Anthropic Messages API.
import { marca } from '../marca';
import { PROGRAMAS } from './catalog';

// El filtro por facultad solo se ofrece si la marca clasifica por facultad. Ofrecerlo con el enum de
// otra marca hace que el modelo filtre por una facultad que ningún programa tiene, y la búsqueda
// devuelve cero sin decir por qué.
const FILTRO_FACULTAD = marca.facultades.length
  ? { facultad: { type: 'string', enum: marca.facultades } }
  : {};

// La sede solo existe donde hay programas presenciales. Carver es 100% en línea en cinco países:
// ofrecerle "Santiago" o "Temuco" lo llevaría a preguntarle a un cliente peruano por un campus chileno.
// Las modalidades se DERIVAN del catálogo cargado, no se escriben a mano: estaban fijas en
// ['online','presencial'] y eso fallaba por los dos lados. En Carver, donde los 38 programas son en
// línea, el filtro invitaba a buscar "presencial" y devolver cero. En Postgrados dejaba fuera la
// modalidad 'hibrida', que sí existe en el catálogo y no se podía filtrar. Con una sola modalidad el
// filtro no se ofrece: no discrimina nada.
const MODALIDADES = [...new Set(PROGRAMAS.map((p) => p.modalidad).filter(Boolean))].sort();
const FILTRO_MODALIDAD = MODALIDADES.length > 1 ? { modalidad: { type: 'string', enum: MODALIDADES } } : {};

const FILTRO_SEDE =
  marca.key === 'carver'
    ? {}
    : {
        sede: {
          type: 'string',
          enum: ['Santiago', 'Temuco'],
          description:
            'NO usar por defecto. Solo si la herramienta ya te indicó que el programa se imparte en varias sedes presenciales (nunca para programas online).',
        },
      };

// Carver cotiza distinto: beca del 50% ofrecible de entrada y TRES formas de pago con precios fijos.
const DESC_PRECIO_CARVER =
  'Devuelve el precio de una licenciatura o maestría de Carver: arancel de LISTA, la Beca George Washington ' +
  'Carver Grant (50%) que puedes ofrecer directamente, y las TRES formas de pago (mensualidades, semestral y ' +
  'contado) con sus totales. Úsala SIEMPRE que pregunten por precio, becas, cuotas o financiamiento; nunca ' +
  'cotices de memoria ni con el arancel de detalle_programa. Todos los programas son en línea: NO existe el ' +
  'concepto de sede. Los costos que no están en el arancel (titulación, inscripción, retiro) solo vienen ' +
  'cuando la persona los preguntó explícitamente. Si el programa no está disponible (cupos completos u otro ' +
  'motivo) o no se comercializa por este canal, la herramienta te lo indica para que NO lo cotices.';

// Herramientas que solo existen donde la marca las habilita (ver core/channel.ts:TOOLS_WHATSAPP). Se
// arman aparte para no alterar en nada el esquema que ve el modelo de Postgrados.
const TOOLS_CARVER = [
  {
    name: 'obtener_brochure',
    description:
      'Devuelve el enlace VERIFICADO del brochure oficial (PDF) de una licenciatura o maestría: comprueba en el ' +
      'momento que el enlace funciona y que corresponde al programa pedido. Úsala SIEMPRE que la persona pida el ' +
      'brochure, folleto, programa completo, malla o información "en PDF". Comparte ÚNICAMENTE el enlace que ' +
      'devuelve esta herramienta en este mismo turno, tal cual y en una línea aparte. Si devuelve ok=false, NO ' +
      'compartas ningún enlace: sigue la instrucción que trae.',
    input_schema: {
      type: 'object',
      properties: {
        programa: { type: 'string', description: 'Nombre exacto del programa (de consultar_programas).' },
      },
      required: ['programa'],
    },
  },
  {
    name: 'consultar_estado_estudiante',
    description:
      'Verifica en el CRM si la persona de ESTE chat es estudiante matriculado y, si se puede verificar, quién es ' +
      'su Advisor (nombre y correo institucional). Úsala cuando la persona diga ser estudiante o alumno y tenga ' +
      'un inconveniente (plataforma, clases, notas, certificados, pagos de cuotas). No recibe parámetros: solo ' +
      'consulta la ficha de quien escribe.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'consultar_informacion_institucional',
    description:
      'Información institucional VERIFICADA de Carver: calendario de ingresos por ciclo, argumentos de venta, ' +
      'enlace oficial de postulación de su asesor, proceso de admisión y matrícula, y medios de pago oficiales. ' +
      'Úsala ANTES de responder sobre fechas de inicio, cómo postular, los pasos de admisión o por dónde se paga. ' +
      'Si devuelve disponible=false, NO tienes el dato: no lo inventes y sigue la instrucción que trae. En ' +
      '"medios_de_pago", comparte ÚNICAMENTE el enlace que venga en "url"; si una entrada trae ' +
      '"enlaceLoEnviaElAsesor", di que el asesor le envía ese enlace y NO pegues ninguno ni menciones montos.',
    input_schema: {
      type: 'object',
      properties: {
        tema: {
          type: 'string',
          enum: ['calendario_ingresos', 'argumentos_venta', 'enlace_postulacion', 'proceso_admision', 'medios_de_pago'],
        },
      },
      required: ['tema'],
    },
  },
] as const;

// escalar_a_humano distingue la derivación de un estudiante (va a su Advisor) solo donde existe ese flujo.
const ESCALAR_PROPIEDADES = marca.soporteEstudiantes
  ? {
      motivo: { type: 'string' },
      tipo: {
        type: 'string',
        enum: ['comercial', 'soporte_estudiante'],
        description: 'soporte_estudiante si es un estudiante matriculado con un inconveniente; comercial en los demás casos.',
      },
    }
  : { motivo: { type: 'string' } };

export const tools = [
  {
    name: 'consultar_programas',
    description:
      `${marca.catalogoDescripcion} Úsala SIEMPRE antes de informar ` +
      'sobre programas; nunca inventes nombres, facultades, duraciones, modalidades ni URLs. Devuelve la ' +
      'URL oficial de cada programa.',
    input_schema: {
      type: 'object',
      properties: {
        // El enum sale de la marca: es lo ÚNICO que el modelo ve para elegir el tipo, así que si
        // ofrece uno que el catálogo no usa la búsqueda devuelve cero en silencio.
        tipo: { type: 'string', enum: marca.tiposPrograma },
        ...FILTRO_FACULTAD,
        ...FILTRO_MODALIDAD,
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
    description: marca.key === 'carver' ? DESC_PRECIO_CARVER :
      'Devuelve el precio de un programa: por DEFECTO el arancel de LISTA + matrícula + total de lista (lo que se ' +
      'entrega primero), y por separado el bloque "descuento" (descuento institucional disponible) que se revela ' +
      'SOLO si la persona pregunta explícitamente si hay descuentos/becas/promociones. Incluye las cuotas Toku. ' +
      'Úsala SIEMPRE que pregunten por precio, "cuánto sale en total", descuentos, cuotas o financiamiento. NO ' +
      'cotices con el arancel de detalle_programa. Pásale SOLO el nombre: la mayoría de los programas son ONLINE y ' +
      'no tienen sede, así que NO preguntes ni envíes "sede". Envía "sede" únicamente si en una respuesta previa esta ' +
      'herramienta te indicó que el programa se imparte en varias sedes presenciales. Si no cotiza ' +
      '(nuevo/suspendido/beca no habilitada) o no se encuentra, la herramienta te lo indica para que derives; nunca inventes montos.',
    input_schema: {
      type: 'object',
      properties: {
        programa: { type: 'string', description: `Nombre del programa (ej. "${marca.key === 'carver' ? 'Maestría en Inteligencia Artificial' : 'Magíster en Marketing Digital'}").` },
        ...FILTRO_SEDE,
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
        rut: {
          type: 'string',
          description: `Documento de identidad (${marca.etiquetaDocumento}) si el cliente lo entrega. Acepta el formato de su país; no insistas ni lo valides.`,
        },
        profesion: { type: 'string', description: 'Profesión u ocupación del cliente, si la entrega (parte de los antecedentes para su postulación/matrícula).' },
        direccion: { type: 'string', description: 'Dirección del cliente, si la entrega (parte de los antecedentes para su postulación/matrícula).' },
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
    // Solo tiene efecto en WhatsApp (WHATSAPP_PROFILE.toolNames) — es el único canal donde el cliente
    // puede mandar una foto que el bot vea directamente (visión) en el mismo turno.
    name: 'registrar_documento_identidad',
    description:
      'Sube al CRM la foto de un documento de identidad (cédula de identidad chilena) que el cliente ACABA de ' +
      'enviar EN ESTE MISMO turno — solo llámala si estás viendo esa imagen ahora mismo (no la llames por texto, ' +
      'ni para una imagen de un turno anterior, ni para otro tipo de imagen como un comprobante de pago o una ' +
      'captura de pantalla). Úsala cuando el cliente esté avanzando su proceso de matrícula y te haya enviado la ' +
      'foto de su cédula.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'solicitar_llamada',
    description:
      'Dispara una llamada telefónica INMEDIATA de Sofía (nuestra asistente de voz) al cliente. Úsala SOLO cuando el cliente ' +
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
      properties: ESCALAR_PROPIEDADES,
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
  ...(marca.key === 'carver' ? TOOLS_CARVER : []),
] as const;
