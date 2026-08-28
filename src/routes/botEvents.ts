import type { Request, Response } from 'express';
import { extractAuth } from '../bitrix/auth';
import { callBitrix } from '../bitrix/client';
import { getState, setAuth } from '../store';
import { config } from '../config';
import { log } from '../log';
import { runAgentTurn } from '../ai/agentLoop';
import { procesarScoring } from '../ai/scoring';
import { getHistory } from '../ai/memory';
import { getSession, saveSession } from '../session';
import { once } from '../store/kv';
import { inc } from '../obs/metrics';
import { audit } from '../obs/audit';
import { resolveAllEntities, loadPriorContext, logConversationTurn } from '../crm/chat';
import { primaryEntity } from '../crm/entities';
import { esEmpleadoBitrix } from '../crm/directory';
import { createSemaphore } from '../util/concurrency';
import { withKeyedLock } from '../util/distlock';
import { WHATSAPP_PROFILE } from '../core/channel';
import { extractIncomingMedia } from '../media/incoming';
import { transcribeAudio } from '../ai/transcribe';
import { programarSeguimiento, cancelarSeguimiento } from '../ai/seguimiento';
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
  ).catch((e) => log.error('botMessage: error', { err: String(e) }));
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

  const auth = extractAuth(req);
  const botId = firstBotId(body?.data?.BOT) ?? (await getState()).botId ?? config.botId;

  log.info('INBOUND bot message', { event: body.event, dialogId, chatId, entity, fromUserId, botId, msgLen: message?.length ?? 0 });

  if (!auth) return log.warn('botMessage: sin auth en el evento');
  void setAuth(auth).catch(() => {}); // mantiene el token fresco en KV para /setup y scripts
  if (!dialogId) return log.warn('botMessage: sin DIALOG_ID', { params });
  if (!botId) return log.warn('botMessage: sin BOT_ID — define BITRIX_BOT_ID en Railway (701561)');

  // Idempotencia: descarta eventos duplicados (Bitrix puede reenviar).
  const msgId = params.MESSAGE_ID;
  if (msgId && !(await once(`evt:msg:${msgId}`, 3600))) {
    return log.info('botMessage: evento duplicado ignorado', { msgId });
  }

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
      inc('operator_msg');
      void audit({ type: 'operator_msg', dialogId, detail: { fromUser, motivo: 'primer_mensaje_de_empleado' } });
      return log.info('botMessage: primer mensaje del chat es de un empleado (no del cliente); se ignora sin fijar clientId', {
        dialogId,
        fromUser,
      });
    }
    sess.clientId = fromUser; // primer mensaje (ya verificado que no es empleado) = cliente
    sessChanged = true;
  }
  if (sess.clientId && fromUser && fromUser !== sess.clientId) {
    sess.humanTookOver = true; // mensaje de un operador u otro usuario
    await saveSession(dialogId, sess);
    inc('operator_msg');
    void audit({ type: 'operator_msg', dialogId, detail: { fromUser } });
    void cancelarSeguimiento(dialogId); // un humano tomó la conversación: el bot no le manda seguimiento
    return log.info('botMessage: mensaje de operador/otro usuario; bot en silencio', {
      fromUser,
      clientId: sess.clientId,
    });
  }
  if (sess.humanTookOver) {
    return log.info('botMessage: sesión atendida por humano; bot en silencio', { dialogId });
  }
  if (sessChanged) await saveSession(dialogId, sess);

  inc('inbound');

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
  const media = await extractIncomingMedia(params, auth).catch((e) => {
    log.warn('media: extractIncomingMedia falló', { err: String(e) });
    return [] as Awaited<ReturnType<typeof extractIncomingMedia>>;
  });
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
    }
    // Archivo no visualizable (pdf/doc) y nada más que responder.
    const otros = media.filter((m) => m.kind === 'file');
    if (otros.length && !turnContent && !turnText) {
      turnText = `(el cliente envió el archivo "${otros[0].name}" que no puedo abrir por este medio; pídele que te cuente por texto qué necesita)`;
    }
    log.info('media: turno enriquecido', { audios: media.filter((m) => m.kind === 'audio').length, imgs: imgs.length, otros: otros.length });
  }
  if (!turnText && !turnContent) return log.info('botMessage: evento sin texto ni media procesable (ignorado)', { dialogId });
  const logText = turnText || '[imagen]';

  // Identifica las entidades CRM vinculadas al chat (del propio evento; sin llamada extra si viene).
  const crmEntities = await resolveAllEntities(params, chatId, auth);
  const crmEntity = primaryEntity(crmEntities);
  log.info('CRM entity', { primary: crmEntity ? `${crmEntity.type}#${crmEntity.id}` : 'ninguna', all: crmEntities });

  // Memoria entre sesiones: al iniciar una conversación nueva, carga notas previas del CRM.
  const esNueva = (await getHistory(dialogId)).length === 0;
  if (esNueva) inc('conversations');
  const priorContext = esNueva && crmEntity ? await loadPriorContext(crmEntity, auth) : '';

  // Indicador de "escribiendo..." mientras razona el agente (no crítico).
  await callBitrix('imbot.chat.sendTyping', { BOT_ID: botId, DIALOG_ID: dialogId }, auth).catch(() => {});

  // Agente real: motor conversacional único, con el perfil del canal WhatsApp (Open Lines).
  // turnContent (bloques con imagen) tiene prioridad; si no, el texto (incluye audios transcritos).
  const reply = await runAgentTurn(
    { auth, conversationId: dialogId, chatId, botId, crmEntity, crmEntities, profile: WHATSAPP_PROFILE },
    turnContent ?? turnText,
    priorContext,
  );

  await callBitrix('imbot.message.add', { BOT_ID: botId, DIALOG_ID: dialogId, MESSAGE: reply }, auth);
  inc('reply');
  log.info('REPLY enviado', { dialogId, botId });
  void programarSeguimiento(dialogId); // si el cliente no vuelve a escribir, se le manda un seguimiento (ver ai/seguimiento.ts)

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
  void procesarScoring({ dialogId, chatId, botId, crmEntities, auth }).catch((e) =>
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
