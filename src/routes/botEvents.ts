import type { Request, Response } from 'express';
import { extractAuth } from '../bitrix/auth';
import { callBitrix } from '../bitrix/client';
import { getState, setAuth } from '../store';
import { config } from '../config';
import { log } from '../log';
import { runAgentTurn } from '../ai/agentLoop';
import { procesarScoring } from '../ai/scoring';
import { getHistory } from '../ai/memory';
import { getSession, saveSession, sesionOpenLines, traspasoVigente, marcarTraspaso } from '../session';
import { once } from '../store/kv';
import { inc } from '../obs/metrics';
import { audit } from '../obs/audit';
import { resolveAllEntities, loadPriorContext, logConversationTurn } from '../crm/chat';
import { leerHistorialPrevio } from '../crm/historialChat';
import { pideNoMolestar, excluir } from '../crm/exclusion';
import { aplicaCopiloto, entregarBorrador } from '../ai/copiloto';
import { primaryEntity } from '../crm/entities';
import { esEmpleadoBitrix, getIdentidadAsesor, getDatosConocidosDeEntidades, getUsuarios } from '../crm/directory';
import { esAsesorValido } from '../crm/equipo';
import { asesoresDisponibles, motivoHorario } from '../core/horarioAsesores';
import { hayOperadorEnElChat } from '../crm/operadorEnChat';
import { listaBlancaActiva, puedeResponder, lineaDelChat } from '../core/listaBlanca';
import { esperarComoHumano } from '../core/ritmoHumano';
import { asignarAsesorPorTurno } from '../crm/asignacionAsesores';
import { createSemaphore } from '../util/concurrency';
import { withKeyedLock } from '../util/distlock';
import { WHATSAPP_PROFILE, type AgentContext } from '../core/channel';
import { marca } from '../marca';
import { extractIncomingMedia } from '../media/incoming';
import { transcribeAudio } from '../ai/transcribe';
import { programarSeguimiento, cancelarSeguimiento, registrarRespuestaASeguimiento } from '../ai/seguimiento';
import { getRequestContext, runWithRequestContext } from '../obs/requestContext';

// Backpressure: el semáforo acota los turnos concurrentes POR INSTANCIA (decisión deliberada: la
// contrapresión de recursos es un problema por-réplica; el 429 de Anthropic ya lo maneja el SDK con
// reintentos). El lock por diálogo, en cambio, SÍ es distribuido (withKeyedLock): serializa el mismo
// cliente entre réplicas para evitar carreras read-modify-write de historial/sesión.
const turnLimit = createSemaphore(Number(process.env.MAX_CONCURRENT_TURNS ?? 8));

/**
 * Handler de ONIMBOTMESSAGEADD (mensaje del cliente al bot de Open Lines).
 * Responde ACK <1s y procesa en segundo plano (eco).
 *
 * Valida los 3 criterios del PoC (§7.4.6):
 *  1) Recepción del inbound de ChatApp (log "INBOUND ...", entity=LINES)
 *  2) La respuesta llega a WhatsApp (imbot.message.add → ChatApp)
 *  3) Precedencia bot-primero (se observa en el portal/ChatApp)
 */
export async function botMessageHandler(req: Request, res: Response) {
  // Confirma que el endpoint fue invocado (aunque el payload no sea el esperado).
  log.info('POST /events/bot/message recibido', { event: (req.body as any)?.event });
  res.status(200).json({ ok: true }); // ACK inmediato
  // Serializa por diálogo (evita carreras de historial/sesión) y acota la concurrencia global.
  const dialogId = String((req.body as any)?.data?.PARAMS?.DIALOG_ID ?? 'unknown');
  const requestId = getRequestContext()?.requestId ?? '-';
  // Re-vincula el contexto (reqId + dialogId) dentro del lock/semáforo: garantiza que el
  // trabajo en segundo plano loguee con la correlación correcta, sin fugas entre peticiones.
  void withKeyedLock(dialogId, () =>
    turnLimit(() => runWithRequestContext({ requestId, dialogId }, () => handle(req))),
  ).catch((e) => {
    // Red de seguridad: cualquier falla del turno que no se haya registrado más adentro queda igual
    // en la auditoría, para que el panel la muestre en vez de que se pierda solo en los logs.
    inc('errors');
    void audit({ type: 'error', dialogId, detail: { etapa: 'turno', err: String(e) } });
    log.error('botMessage: error', { err: String(e) });
  });
}

async function handle(req: Request) {
  const t0 = Date.now(); // tiempo de respuesta del bot (recepción → reply enviado), para el panel
  const body: any = req.body ?? {};
  const params = body?.data?.PARAMS ?? {};
  const dialogId: string | undefined = params.DIALOG_ID;
  const chatId = params.CHAT_ID;
  const message: string | undefined = params.MESSAGE;
  const entity: string | undefined =
    params.CHAT_ENTITY_TYPE ?? params?.CHAT?.CHAT_ENTITY_TYPE;
  const fromUserId = params.FROM_USER_ID;

  const authEvento = extractAuth(req);
  const st = await getState();
  const botId = firstBotId(body?.data?.BOT) ?? st.botId ?? config.botId;
  // El bot habla con Bitrix usando el token del INSTALADOR (tiene la aplicación concedida), no el que
  // viene en el evento: ese es del usuario que lo disparó y, si no tiene la app, Bitrix rechaza
  // imbot.message.add con "user_access_error" y el cliente queda sin respuesta (incidente Carver
  // 2026-10-24: el token del evento venía de un usuario sin acceso y NINGÚN mensaje se podía enviar).
  // Sin token de instalación guardado (instalaciones viejas, hasta el próximo reinstall) cae al del
  // evento, como antes. El token del evento igual se persiste más abajo para /setup y lo proactivo.
  const auth = st.installAuth ?? authEvento;

  log.info('INBOUND bot message', { event: body.event, dialogId, chatId, entity, fromUserId, botId, msgLen: message?.length ?? 0 });

  if (!auth) return log.warn('botMessage: sin auth en el evento');
  if (!dialogId) return log.warn('botMessage: sin DIALOG_ID', { params });
  if (!botId) return log.warn('botMessage: sin BOT_ID — define BITRIX_BOT_ID en Railway (701561)');

  // Idempotencia: descarta eventos duplicados (Bitrix puede reenviar).
  const msgId = params.MESSAGE_ID;
  if (msgId && !(await once(`evt:msg:${msgId}`, 3600))) {
    return log.info('botMessage: evento duplicado ignorado', { msgId });
  }

  // Compuerta de líneas: si config.openlinesLineasPermitidas está definida, el bot solo responde en esas
  // líneas de Open Lines y calla en el resto —incluidas conversaciones ya abiertas—, sin depender de la
  // config de Bitrix (p. ej. Carver solo en la 93; deja de atender WhatsApp línea 31). Vacía = sin
  // restricción (Postgrados). Fail-closed: si no se puede determinar la línea, no responde; la lista
  // existe justamente para restringir, y mejor un silencio de más que atender un canal que no debía.
  if (config.openlinesLineasPermitidas.length) {
    const linea = await lineaDelChat(chatId, auth);
    if (!linea || !config.openlinesLineasPermitidas.includes(linea)) {
      void audit({ type: 'bot_en_silencio', dialogId, detail: { motivo: 'linea_no_permitida', chatId, linea: linea ?? null } });
      return log.info('botMessage: línea fuera de la lista permitida; bot en silencio', { dialogId, chatId, linea });
    }
  }

  // Sesión de Open Lines del mensaje: un traspaso a una persona vale mientras dure ESTA sesión.
  const sesion = sesionOpenLines(params.CHAT_ENTITY_DATA_1 ?? params?.CHAT?.CHAT_ENTITY_DATA_1);

  // ── El bot solo responde al CLIENTE; si interviene un operador, se calla (humano a cargo) ──
  const fromUser = String(fromUserId ?? '');
  const sess = await getSession(dialogId);
  let sessChanged = false;
  if (!sess.clientId && fromUser) {
    // Antes de fijar el primer remitente como "el cliente", verifica que NO sea un EMPLEADO real del
    // portal. En deals reactivados el primer evento del chat a veces lo dispara el propio asesor (no
    // el cliente) — si se fijara clientId a su ID, el mensaje real del cliente que llega después
    // quedaría mal clasificado como "un operador escribió" y el bot se callaría para siempre en esa
    // conversación (bug confirmado en producción: deal #3490143, Ruben Castrillon).
    if (await esEmpleadoBitrix(Number(fromUser), auth)) {
      // No se fija clientId, pero SÍ se registra que hay una persona atendiendo: si es un asesor del
      // equipo, el bot se retira de la conversación. Antes solo se ignoraba el mensaje, así que
      // cuando el asesor escribía PRIMERO —que es lo habitual cuando toma un lead— el bot no se
      // enteraba de nada y volvía a meterse apenas el cliente contestaba.
      //
      // Se exige que sea un asesor VÁLIDO del equipo: un mensaje del usuario del webhook o de un
      // robot no es alguien atendiendo, y callar al bot por eso lo dejaría mudo sin que nadie haya
      // tomado el caso.
      const [u] = await getUsuarios([Number(fromUser)], auth);
      const esAsesor = esAsesorValido(u);
      if (esAsesor) {
        sess.humanTookOver = true;
        await saveSession(dialogId, sess);
        if (marca.traspasoPorSesion) await marcarTraspaso(dialogId, sesion, 'operador');
        void cancelarSeguimiento(dialogId);
      }
      inc('operator_msg');
      void audit({
        type: 'operator_msg',
        dialogId,
        detail: { fromUser, motivo: 'primer_mensaje_de_empleado', asesorDelEquipo: esAsesor },
      });
      return log.info('botMessage: primer mensaje del chat es de un empleado (no del cliente); se ignora sin fijar clientId', {
        dialogId,
        fromUser,
        asesorDelEquipo: esAsesor,
      });
    }
    sess.clientId = fromUser; // primer mensaje (ya verificado que no es empleado) = cliente
    sessChanged = true;
  }
  if (sess.clientId && fromUser && fromUser !== sess.clientId) {
    sess.humanTookOver = true; // mensaje de un operador u otro usuario
    await saveSession(dialogId, sess);
    if (marca.traspasoPorSesion) await marcarTraspaso(dialogId, sesion, 'operador');
    inc('operator_msg');
    void audit({ type: 'operator_msg', dialogId, detail: { fromUser } });
    void cancelarSeguimiento(dialogId); // un humano tomó la conversación: el bot no le manda seguimiento
    return log.info('botMessage: mensaje de operador/otro usuario; bot en silencio', {
      fromUser,
      clientId: sess.clientId,
    });
  }
  // Modo prueba: con una lista blanca configurada, el bot solo le responde a esos números. Va
  // antes que cualquier otro filtro porque es el más fuerte: si este chat no está en la lista, da
  // igual la hora, el traspaso o quién esté en el chat.
  if (listaBlancaActiva() && !(await puedeResponder(chatId, auth))) {
    inc('bot_en_silencio_lista_blanca');
    void audit({ type: 'bot_en_silencio', dialogId, detail: { motivo: 'modo_prueba', chatId } });
    return log.info('botMessage: modo prueba, número fuera de la lista; bot en silencio', { dialogId, chatId });
  }

  if (sess.humanTookOver) {
    return log.info('botMessage: sesión atendida por humano; bot en silencio', { dialogId });
  }


  // Recién acá se persiste el token, con el evento ya identificado como mensaje de un CLIENTE.
  // Antes se guardaba el de cualquier evento, incluidos los que dispara un asesor al escribir en el
  // chat: ese token es SUYO y, si no tiene concedida la aplicación, no sirve para imbot.message.add.
  // Todo lo proactivo salía con él y Bitrix lo rechazaba, mientras las respuestas en vivo seguían
  // bien porque usan el token del propio evento. Costó 11 recordatorios en Carver.
  if (authEvento) void setAuth(authEvento).catch(() => {}); // persiste el token del evento en KV (self-healing de s.auth) para /setup y scripts; las llamadas del bot usan installAuth
  // El estado de arriba vive 6 h; el traspaso, toda la sesión de Open Lines. Sin esto el bot volvía a
  // contestar —hablando como el asesor— en chats que ya atendía una persona (piloto de Carver).
  if (marca.traspasoPorSesion) {
    const t = await traspasoVigente(dialogId, sesion);
    if (t) {
      inc('bot_en_silencio_traspaso');
      void audit({ type: 'bot_en_silencio', dialogId, detail: { motivo: t.motivo, sesion } });
      return log.info('botMessage: la sesión ya fue traspasada a una persona; bot en silencio', { dialogId, sesion, motivo: t.motivo });
    }
  }
  // En horario de asesores el bot no se mete: el chat es de ellos. Se audita para que el silencio
  // sea MEDIBLE — es la contrapartida de callar sin responder: si alguien queda sin atención, al
  // menos queda el registro de cuántos mensajes llegaron mientras el bot estaba apagado.
  // Alguien recogió la conversación desde Bitrix. Bitrix NO le entrega al bot los mensajes de los
  // operadores, así que sin esto el bot no se entera de nada y responde por encima del asesor, que
  // es exactamente lo que pasó en el deal #3649251.
  if (await hayOperadorEnElChat(chatId, auth, sess.clientId)) {
    sess.humanTookOver = true;
    await saveSession(dialogId, sess);
    if (marca.traspasoPorSesion) await marcarTraspaso(dialogId, sesion, 'operador');
    void cancelarSeguimiento(dialogId);
    inc('operator_msg');
    void audit({ type: 'operator_msg', dialogId, detail: { motivo: 'operador_en_el_chat', chatId } });
    return log.info('botMessage: una persona está en el chat; bot en silencio', { dialogId, chatId });
  }

  if (asesoresDisponibles()) {
    // No basta con callar: el canal está configurado con "No transferir", así que si el bot recibe
    // la conversación y no hace nada, NADIE la recibe después y la persona queda esperando para
    // siempre. Se entrega a la cola en el acto, que es lo que haría el canal si el bot no existiera.
    let entregada = false;
    try {
      await callBitrix('imopenlines.bot.session.operator', { CHAT_ID: chatId }, auth);
      entregada = true;
      if (marca.traspasoPorSesion) await marcarTraspaso(dialogId, sesion, 'horario_asesores');
      void cancelarSeguimiento(dialogId);
    } catch (e) {
      log.warn('no se pudo entregar la sesión a la cola en horario de asesores', { err: String(e), dialogId, chatId });
    }
    inc('bot_en_silencio_horario');
    void audit({ type: 'bot_en_silencio', dialogId, detail: { motivo: 'horario_asesores', detalle: motivoHorario(), entregada } });
    return log.info('botMessage: hay asesores atendiendo; sesión entregada a la cola', { dialogId, motivo: motivoHorario(), entregada });
  }

  if (sessChanged) await saveSession(dialogId, sess);

  inc('inbound');
  // Si lo último que recibió fue un recordatorio, este mensaje lo RESPONDE: es lo que separa un
  // contacto efectivo de un mensaje enviado (ver ai/seguimiento.ts).
  void registrarRespuestaASeguimiento(dialogId);

  // ── Media entrante (audio/imagen) por WhatsApp ──────────────────────────────────────────────
  // Antes se descartaba todo lo que no fuera texto. Ahora: los audios se transcriben (Deepgram) y
  // se tratan como texto del cliente; las imágenes se pasan a la visión de Claude como bloques.
  let turnText = (message ?? '').trim();
  let turnContent: any[] | null = null;
  if (!message) {
    log.info('botMessage: evento sin texto — diagnóstico de media', {
      paramsKeys: Object.keys(params),
      files: params.FILES ?? params.files ?? null,
    });
  }
  const media = await extractIncomingMedia(params, auth, botId).catch((e) => {
    log.warn('media: extractIncomingMedia falló', { err: String(e) });
    return [] as Awaited<ReturnType<typeof extractIncomingMedia>>;
  });
  // Última imagen del turno (si hay) — se le pasa al agente para que una tool pueda subir los bytes
  // reales al CRM si el modelo reconoce que es un documento (ver registrar_documento_identidad).
  let pendingImage: { base64: string; mediaType: string } | null = null;
  if (media.length) {
    // Audios → transcripción (se agregan como texto del cliente).
    for (const a of media.filter((m) => m.kind === 'audio')) {
      const t = await transcribeAudio(a.base64, a.mediaType);
      turnText = [turnText, t ?? '(el cliente envió un audio que no se pudo transcribir; pídele amablemente que escriba su consulta)']
        .filter(Boolean)
        .join(' ')
        .trim();
    }
    // Imágenes → bloques de visión (máx 3), con el texto/caption como primer bloque.
    const imgs = media.filter((m) => m.kind === 'image').slice(0, 3);
    if (imgs.length) {
      const blocks: any[] = [
        {
          type: 'text',
          text:
            turnText ||
            'El cliente envió una imagen sin texto. Interprétala y responde su consulta (puede ser un carnet, un comprobante de pago, una captura o un documento).',
        },
      ];
      for (const img of imgs) blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
      turnContent = blocks;
      pendingImage = { base64: imgs[0].base64, mediaType: imgs[0].mediaType };
    }
    // Archivo no visualizable (pdf/doc) y nada más que responder.
    const otros = media.filter((m) => m.kind === 'file');
    if (otros.length && !turnContent && !turnText) {
      turnText = `(el cliente envió el archivo "${otros[0].name}" que no puedo abrir por este medio; pídele que te cuente por texto qué necesita)`;
    }
    log.info('media: turno enriquecido', { audios: media.filter((m) => m.kind === 'audio').length, imgs: imgs.length, otros: otros.length });
  }
  // El cliente mandó un adjunto (según el evento) pero NINGUNO se pudo bajar/procesar (ver logs de
  // media: arriba) — antes esto dejaba el turno sin texto ni contenido y el bot ignoraba el mensaje
  // en silencio (caso real: el cliente nunca recibía respuesta). Mejor avisarle que no se pudo abrir
  // el adjunto en vez de callarse.
  const habiaAdjunto = !!(params.FILES ?? params.files);
  if (!turnText && !turnContent && habiaAdjunto && !media.length) {
    turnText = '(el cliente envió un archivo que no se pudo procesar por este medio; pídele amablemente que cuente por texto qué necesita)';
  }
  if (!turnText && !turnContent) return log.info('botMessage: evento sin texto ni media procesable (ignorado)', { dialogId });
  const logText = turnText || '[imagen]';

  // Identifica las entidades CRM vinculadas al chat (del propio evento; sin llamada extra si viene).
  const crmEntities = await resolveAllEntities(params, chatId, auth);
  const crmEntity = primaryEntity(crmEntities);
  log.info('CRM entity', { primary: crmEntity ? `${crmEntity.type}#${crmEntity.id}` : 'ninguna', all: crmEntities });

  // Si la conversación es de un programa piloto, el deal queda con SU asesor desde el primer mensaje,
  // sin esperar a que la persona entregue datos. Antes la asignación solo se disparaba al capturar un
  // dato, al escalar o por silencio: quien preguntaba y no dejaba nada se quedaba con el responsable
  // por defecto del embudo (caso real: deal #3581633). Sin tarea, para no llenarle los pendientes al
  // asesor por cada consulta suelta — la tarea se crea igual cuando el bot escala o tras el silencio.
  void asignarAsesorPorTurno(crmEntities, auth, 'automatico', { crearTarea: false }).catch((e) =>
    log.warn('asignación temprana falló', { err: String(e), dialogId }),
  );

  // Memoria entre sesiones: al iniciar una conversación nueva, carga notas previas del CRM.
  const esNueva = (await getHistory(dialogId)).length === 0;
  if (esNueva) inc('conversations');
  // Dos memorias distintas, y hacían falta las dos: loadPriorContext son las notas que el propio bot
  // dejó en el CRM en sesiones anteriores; el historial del chat es lo que se habló en ESTE chat
  // antes de que el bot entrara — típicamente un asesor atendiendo a mano. Sin lo segundo, sumar el
  // bot a una conversación en curso lo hacía arrancar en blanco y repetir lo ya preguntado.
  const [priorContext, historialPrevio] = esNueva
    ? await Promise.all([
        crmEntity ? loadPriorContext(crmEntity, auth) : Promise.resolve(''),
        leerHistorialPrevio(dialogId, sess.clientId, auth, msgId),
      ])
    : ['', null];

  // "Escribiendo…" + espera de ritmo humano: el bot no contesta al instante (parece menos robot). Con
  // el delay desactivado (config por defecto) solo muestra el indicador, como antes. Ver core/ritmoHumano.ts.
  await esperarComoHumano(botId, dialogId, auth);

  // Agente real: motor conversacional único, con el perfil del canal WhatsApp (Open Lines).
  // turnContent (bloques con imagen) tiene prioridad; si no, el texto (incluye audios transcritos).
  // Identidad del turno: con marca.sePresentaComoAsesor el bot habla como el asesor dueño de la
  // negociación, no como sí mismo. Se resuelve por turno (cacheado 5 min) porque el responsable
  // puede cambiar a mitad de la conversación — p. ej. cuando el reparto automático la asigna.
  const identidadAsesor =
    marca.sePresentaComoAsesor && (crmEntities?.deal || crmEntities?.lead || crmEntities?.contact)
      ? await getIdentidadAsesor(crmEntities, auth)
      : null;

  // Si pide explícitamente que no le escribamos más, queda registrado ANTES de contestar. No corta
  // esta conversación —el cliente la abrió y merece respuesta—, pero lo deja fuera de todo envío
  // proactivo futuro. Poder escribir primero obliga a respetar al que dice que no.
  if (turnText && pideNoMolestar(turnText)) {
    void excluir({ contactId: crmEntities?.contact, dialogId, motivo: 'pedido_del_cliente' });
  }

  // Lo que el CRM ya sabe de la persona: evita pedirle el nombre que ya está en su ficha. Un cliente
  // real lo reclamó ("¿por qué me pides mi nombre si lo debes tener?") y tenía razón.
  const datosConocidos = crmEntities ? await getDatosConocidosDeEntidades(crmEntities, auth) : null;

  const ctxTurno: AgentContext = {
    auth,
    identidadAsesor,
    datosConocidos,
    conversationId: dialogId,
    chatId,
    botId,
    crmEntity,
    crmEntities,
    profile: WHATSAPP_PROFILE,
    pendingImage,
    ultimoMensajeCliente: turnText,
    sesionOpenLines: sesion,
  };
  const reply = await runAgentTurn(ctxTurno, turnContent ?? turnText, priorContext, undefined, historialPrevio);

  // Si el envío falla, el cliente se queda SIN respuesta: hay que dejar rastro accionable, no solo
  // un log. Antes esto no quedaba registrado en ninguna parte y 3 clientes reales quedaron sin
  // contestación sin que nadie se enterara (ver fix 748885f).
  // Modo copiloto: el borrador va al asesor y el cliente NO recibe nada automático. Si el borrador
  // no se puede entregar, se responde normalmente: dejar al cliente sin respuesta sería peor que
  // saltarse el modo, y el asesor ya tiene el caso en su panel igual.
  if (await aplicaCopiloto(crmEntities, auth)) {
    const r = await entregarBorrador({ respuesta: reply, mensajeCliente: turnText, dialogId, crmEntities, auth });
    if (r.entregado) {
      inc('copiloto_borrador');
      await audit({
        type: 'turn',
        dialogId,
        crmEntity: crmEntity ? `${crmEntity.type}#${crmEntity.id}` : undefined,
        detail: { message: turnText, reply, copiloto: true, ms: Date.now() - t0 },
      });
      return;
    }
    log.warn('copiloto: sin poder entregar el borrador; se responde al cliente como siempre', { dialogId, motivo: r.motivo });
  }

  try {
    await callBitrix('imbot.message.add', { BOT_ID: botId, DIALOG_ID: dialogId, MESSAGE: reply }, auth);
  } catch (e) {
    inc('errors');
    await audit({
      type: 'error',
      dialogId,
      crmEntity: crmEntity ? `${crmEntity.type}#${crmEntity.id}` : undefined,
      detail: { etapa: 'envio_respuesta', err: String(e) },
    });
    log.error('REPLY no se pudo enviar: el cliente quedó sin respuesta', { err: String(e), dialogId, botId });
    return; // no se audita el turno como exitoso ni se sigue: el cliente no recibió nada
  }
  inc('reply');
  log.info('REPLY enviado', { dialogId, botId });

  // Recién ahora se entrega la sesión al asesor (la marcó escalar_a_humano): al hacerlo, Bitrix le
  // quita al bot el permiso de escribir en ese chat, así que ANTES de este punto la despedida no
  // habría llegado nunca. Si fallara, el cliente igual recibió su respuesta y el asesor ya quedó
  // asignado con su tarea (ver crm/asignacionAsesores.ts), así que no se corta el turno.
  if (ctxTurno.transferirAOperador) {
    try {
      await callBitrix('imopenlines.bot.session.operator', { CHAT_ID: chatId }, auth);
      log.info('sesión entregada al operador tras responder', { dialogId, chatId });
    } catch (e) {
      // "Operator is not a bot": la sesión ya la atiende una persona. El bot igual queda en silencio
      // (escalar_a_humano ya lo marcó); se deja constancia de por qué no hubo traspaso.
      log.warn('no se pudo entregar la sesión al operador', { err: String(e), dialogId, chatId });
    }
  }
  void programarSeguimiento(dialogId, crmEntities, sesion); // si el cliente no vuelve a escribir: recordatorio y, si sigue en silencio, transferencia al asesor (ver ai/seguimiento.ts)

  // Auditoría del turno (compliance) — independiente del CRM.
  await audit({
    type: 'turn',
    dialogId,
    crmEntity: crmEntity ? `${crmEntity.type}#${crmEntity.id}` : undefined,
    detail: { message: logText, reply, responseMs: Date.now() - t0 },
  });

  // Registra automáticamente la conversación en el timeline del CRM (no bloquea la respuesta).
  if (crmEntity) {
    logConversationTurn(crmEntity, logText, reply, auth).catch((e) =>
      log.warn('logConversationTurn falló', { err: String(e) }),
    );
  }

  // Lead scoring en segundo plano (Haiku): puntúa, mueve etapa del deal y auto-escala si el score es alto.
  void procesarScoring({ dialogId, chatId, botId, crmEntities, auth, sesionOpenLines: sesion }).catch((e) =>
    log.warn('procesarScoring falló', { err: String(e) }),
  );
}

function firstBotId(bot: any): number | undefined {
  if (!bot || typeof bot !== 'object') return undefined;
  const k = Object.keys(bot)[0];
  return k ? Number(k) : undefined;
}

export function botWelcomeHandler(req: Request, res: Response) {
  // No enviamos saludo aquí: el agente saluda al responder el primer mensaje del cliente
  // (evita el doble saludo y da un saludo contextual).
  log.info('POST /events/bot/welcome recibido (join, sin saludo fijo)', { event: (req.body as any)?.event });
  res.status(200).json({ ok: true });
}

export function botDeleteHandler(_req: Request, res: Response) {
  log.info('bot delete event');
  res.status(200).json({ ok: true });
}
