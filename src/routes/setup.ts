import type { Request, Response } from 'express';
import { listarPlantillas as listarPlantillasChatApp, enviarPlantilla as enviarPlantillaChatApp } from '../whatsapp/chatapp';
import { getState, setBotId, EMPTY_AUTH } from '../store';
import { registerBot, unregisterBot, updateBot } from '../bot/register';
import { callBitrix, callWebhook } from '../bitrix/client';
import { getDealAsesores } from '../crm/directory';
import { bindDashboard, bindCalls } from '../bitrix/placement';
import { syncCalls } from '../crm/callSync';
import { dbEnabled, dbDialogosTodos, dbBorrarDialogos } from '../store/db';
import { config } from '../config';
import { log } from '../log';
import type { BitrixCategory, BitrixCategoryListResponse, BitrixStatus, BitrixStatusListResponse } from '../bitrix/types';

/** (Re)enlaza el panel de métricas como página dentro de Bitrix24. GET /setup/bind-dashboard */
export async function bindDashboardManual(_req: Request, res: Response) {
  const st = await getState();
  if (!st.auth) return res.status(400).json({ ok: false, error: 'No hay auth. Instala el app (/install) primero.' });
  const r = await bindDashboard(st.auth);
  return res.status(r.ok ? 200 : 500).json(r);
}

/** (Re)enlaza la página de Analítica de Llamadas dentro de Bitrix24. GET /setup/bind-calls */
export async function bindCallsManual(_req: Request, res: Response) {
  const st = await getState();
  if (!st.auth) return res.status(400).json({ ok: false, error: 'No hay auth. Instala el app (/install) primero.' });
  const r = await bindCalls(st.auth);
  return res.status(r.ok ? 200 : 500).json(r);
}

/** Sincroniza las llamadas (voximplant.statistic.get → Postgres) EN SEGUNDO PLANO. GET /setup/sync-calls */
export async function syncCallsManual(_req: Request, res: Response) {
  if (!dbEnabled()) return res.status(400).json({ ok: false, error: 'Postgres desactivado (define DATABASE_URL en Railway).' });
  const st = await getState();
  // Fire-and-forget: el backfill puede tardar minutos; no bloqueamos la respuesta HTTP.
  void syncCalls(st.auth ?? EMPTY_AUTH).then((r) => log.info('sync manual de llamadas', r));
  return res.json({ ok: true, started: true, mensaje: 'Sincronización iniciada en segundo plano. Revisa /calls en unos minutos.' });
}

/** Diagnóstico: trae el responsable (ASSIGNED_BY_ID) y observadores de un deal. GET /setup/deal-responsable?id=NNN */
export async function dealResponsable(req: Request, res: Response) {
  const id = Number(req.query.id);
  if (!id) return res.status(400).json({ ok: false, error: 'Falta ?id=<dealId> (ej. /setup/deal-responsable?id=77)' });
  const st = await getState();
  if (!st.auth && !config.bitrixWebhookUrl) {
    return res.status(400).json({ ok: false, error: 'No hay auth ni BITRIX_WEBHOOK_URL.' });
  }
  try {
    const { responsable, observadores, info } = await getDealAsesores(id, st.auth ?? EMPTY_AUTH);
    res.json({
      ok: true,
      via: config.bitrixWebhookUrl ? 'webhook' : 'app-token',
      dealId: id,
      titulo: info.titulo,
      categoryId: info.categoryId,
      stageId: info.stageId,
      responsable,
      observadores,
      nota: responsable?.nombre?.startsWith('Usuario ')
        ? 'Se obtuvo el ID del responsable pero no su nombre: agrega el scope "user" (Usuarios) al webhook entrante para resolver nombre/email.'
        : undefined,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
}

/** Lista las etapas (STAGE_ID) de cada embudo de Deal + diagnóstico, para configurar BITRIX_STAGE_SCORE_*. */
export async function listDealStages(_req: Request, res: Response) {
  const st = await getState();
  if (!st.auth && !config.bitrixWebhookUrl) {
    return res.status(400).json({ ok: false, error: 'No hay auth ni BITRIX_WEBHOOK_URL. Instala el app o define el webhook.' });
  }

  // El token del bot es no-Intranet (crm.category.list da allowed_only_intranet_user).
  // Si hay un webhook entrante (creado por un admin), úsalo: corre con permisos completos.
  const useWebhook = Boolean(config.bitrixWebhookUrl);
  const call = (method: string, params: any) =>
    useWebhook ? callWebhook(method, params, config.bitrixWebhookUrl) : callBitrix(method, params, st.auth!);

  const debug: any = { via: useWebhook ? 'webhook' : 'app-token' };
  const stages: any[] = [];

  let categoryIds: number[] = [0];
  try {
    const c = (await call('crm.category.list', { entityTypeId: 2 })) as BitrixCategoryListResponse;
    const list: BitrixCategory[] = Array.isArray(c) ? c : (c?.categories ?? []);
    categoryIds = Array.from(new Set([0, ...list.map((x) => Number(x.id))]));
    debug.categories = list.map((x) => ({ id: x.id, name: x.name }));
  } catch (e) {
    debug.categoryListError = String(e);
  }

  debug.statusList = [];
  for (const id of categoryIds) {
    const entityId = id === 0 ? 'DEAL_STAGE' : `DEAL_STAGE_${id}`;
    try {
      const r = (await call('crm.status.list', { filter: { ENTITY_ID: entityId } })) as BitrixStatusListResponse;
      const arr: BitrixStatus[] = Array.isArray(r) ? r : (r?.result ?? []);
      debug.statusList.push({ entityId, count: arr.length });
      for (const s of arr) stages.push({ categoryId: id, STATUS_ID: s.STATUS_ID, NAME: s.NAME });
    } catch (e) {
      debug.statusList.push({ entityId, error: String(e) });
    }
  }

  res.json({ ok: true, via: debug.via, total: stages.length, stages, debug });
}

/** Lista los campos personalizados (UF) del Deal + su código y etiqueta. GET /setup/deal-fields[?q=nombre] */
export async function listDealFields(req: Request, res: Response) {
  const st = await getState();
  if (!st.auth && !config.bitrixWebhookUrl) {
    return res.status(400).json({ ok: false, error: 'No hay auth ni BITRIX_WEBHOOK_URL.' });
  }
  const useWebhook = Boolean(config.bitrixWebhookUrl);
  const call = (method: string, params: any) =>
    useWebhook ? callWebhook(method, params, config.bitrixWebhookUrl) : callBitrix(method, params, st.auth!);
  const q = String(req.query.q ?? '').toLowerCase();
  try {
    const r = (await call('crm.deal.userfield.list', {})) as any;
    const arr: any[] = Array.isArray(r) ? r : (r?.result ?? []);
    const label = (f: any) => {
      const l = f.EDIT_FORM_LABEL ?? f.LIST_COLUMN_LABEL ?? f.FIELD_NAME;
      return typeof l === 'object' ? (l.es ?? l.en ?? Object.values(l)[0] ?? '') : l;
    };
    let fields = arr.map((f) => ({ code: f.FIELD_NAME, type: f.USER_TYPE_ID, label: label(f), id: f.ID }));
    if (q) fields = fields.filter((f) => String(f.code).toLowerCase().includes(q) || String(f.label).toLowerCase().includes(q));
    return res.json({ ok: true, via: useWebhook ? 'webhook' : 'app-token', total: fields.length, fields });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}

/** Registro manual del bot (si el auto-registro en /install no se ejecutó). */
export async function registerBotManual(_req: Request, res: Response) {
  const st = await getState();
  if (!st.auth) {
    return res.status(400).json({ ok: false, error: 'No hay auth. Instala el app (/install) primero.' });
  }
  try {
    const botId = await registerBot(st.auth);
    await setBotId(botId);
    log.info('setup: bot registrado', { botId });
    return res.json({ ok: true, botId });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}

/** Renombra el bot de Open Lines ya registrado a "Sofía" (imbot.update). GET /setup/update-bot */
export async function updateBotManual(_req: Request, res: Response) {
  const st = await getState();
  const botId = st.botId ?? config.botId;
  if (!st.auth) {
    return res.status(400).json({ ok: false, error: 'No hay auth. Instala el app (/install) primero.' });
  }
  if (!botId) {
    return res.status(400).json({ ok: false, error: 'Falta botId (define BITRIX_BOT_ID o registra el bot con /setup/register-bot).' });
  }
  try {
    const resultado = await updateBot(st.auth, botId);
    log.info('setup: bot actualizado (nombre → Sofía)', { botId, resultado });
    return res.json({ ok: true, botId, resultado });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}

/** Dispara el bizproc "sender" del brochure para un deal (reenviar el correo institucional sin llamada).
 *  Usa el webhook si está definido: el token del app NO tiene scope bizproc (insufficient_scope).
 *  GET /setup/test-brochure?deal=NNN */
export async function triggerBrochureManual(req: Request, res: Response) {
  const dealId = Number(req.query.deal);
  if (!dealId) return res.status(400).json({ ok: false, error: 'Falta ?deal=<dealId> (ej. /setup/test-brochure?deal=3355933)' });
  const st = await getState();
  if (!st.auth && !config.bitrixWebhookUrl) return res.status(400).json({ ok: false, error: 'No hay auth ni BITRIX_WEBHOOK_URL.' });
  if (!config.bizprocTemplateBrochure) return res.status(400).json({ ok: false, error: 'Falta BITRIX_BIZPROC_TEMPLATE_BROCHURE.' });
  const useWebhook = Boolean(config.bitrixWebhookUrl);
  try {
    const params = { TEMPLATE_ID: Number(config.bizprocTemplateBrochure), DOCUMENT_ID: ['crm', 'CCrmDocumentDeal', `DEAL_${dealId}`] };
    const resultado = useWebhook
      ? await callWebhook('bizproc.workflow.start', params, config.bitrixWebhookUrl)
      : await callBitrix('bizproc.workflow.start', params, st.auth!);
    log.info('setup: brochure disparado', { dealId, template: config.bizprocTemplateBrochure, via: useWebhook ? 'webhook' : 'app-token', resultado });
    return res.json({ ok: true, dealId, template: config.bizprocTemplateBrochure, via: useWebhook ? 'webhook' : 'app-token', resultado });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}

/** Limpieza: desregistra el bot. */
export async function unregisterBotManual(_req: Request, res: Response) {
  const st = await getState();
  if (!st.auth || !st.botId) {
    return res.status(400).json({ ok: false, error: 'Falta auth o botId.' });
  }
  try {
    await unregisterBot(st.auth, st.botId);
    log.info('setup: bot desregistrado', { botId: st.botId });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}

/**
 * Diagnóstico del panel dentro de Bitrix24: qué placements tiene registrados ESTA app y si Bitrix la
 * considera instalada. GET /setup/placement-info
 *
 * Existe porque el ítem de menú de Carver no aparecía y no había forma de saber si el placement
 * estaba mal enlazado, mal nombrado, o si el problema era que Bitrix no da por instalada la app
 * (su instalación nunca corrió: se resolvió por canje OAuth, ver routes/install.ts).
 */
export async function placementInfo(_req: Request, res: Response) {
  const st = await getState();
  if (!st.auth) return res.status(400).json({ ok: false, error: 'No hay auth. Instala el app primero.' });
  const out: Record<string, unknown> = { dominio: st.auth.domain, botId: st.botId ?? null };
  try {
    out.placements = await callBitrix('placement.get', {}, st.auth);
  } catch (e) {
    out.placementsError = String(e);
  }
  try {
    out.app = await callBitrix('app.info', {}, st.auth);
  } catch (e) {
    out.appError = String(e);
  }
  return res.json({ ok: true, ...out });
}

/** Lista los diálogos registrados (solo lectura). GET /setup/dialogos */
export async function dialogosListar(_req: Request, res: Response) {
  return res.json({ ok: true, dialogos: await dbDialogosTodos() });
}

/**
 * Borra los diálogos indicados de la auditoría. GET /setup/dialogos/borrar?ids=a,b
 * Irreversible, y por eso pide los ids uno por uno: sin comodines ni prefijos.
 */
export async function dialogosBorrar(req: Request, res: Response) {
  const ids = String(req.query.ids ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) return res.status(400).json({ ok: false, error: 'Falta ids=dialogo1,dialogo2 (explícitos).' });
  try {
    return res.json({ ok: true, ...(await dbBorrarDialogos(ids)) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}

/**
 * Plantillas de WhatsApp disponibles en ChatApp, con su UUID. GET /setup/chatapp-plantillas
 *
 * Vive acá y no en un script porque las credenciales de ChatApp están en el servicio, no en la
 * máquina de quien lo consulta: la comprobación tiene que correr donde está la configuración real.
 * Sirve de paso para verificar que email/password/appId quedaron bien cargados.
 */
export async function chatappPlantillas(req: Request, res: Response) {
  if (!config.chatappEmail || !config.chatappPassword || !config.chatappAppId) {
    return res.status(400).json({
      ok: false,
      error: 'Faltan credenciales de ChatApp',
      falta: {
        CHATAPP_EMAIL: !config.chatappEmail,
        CHATAPP_PASSWORD: !config.chatappPassword,
        CHATAPP_APP_ID: !config.chatappAppId,
      },
    });
  }
  const licencia = Number(req.query.licencia ?? config.chatappLicenseId) || config.chatappLicenseId;
  if (!licencia) return res.status(400).json({ ok: false, error: 'Falta CHATAPP_LICENSE_ID' });
  try {
    const items = await listarPlantillasChatApp(licencia);
    return res.json({
      ok: true,
      licencia,
      total: items.length,
      aprobadas: items.filter((t) => t.status === 'APPROVED').length,
      plantillas: items.map((t) => ({
        id: t.id,
        nombre: t.elementName,
        idioma: t.languageCode,
        estado: t.status,
        tipo: t.templateType,
        texto: String(t.data ?? '').replace(/\s+/g, ' ').slice(0, 200),
      })),
    });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e).slice(0, 400) });
  }
}

/**
 * Envío de prueba de una plantilla a UN número. GET /setup/chatapp-prueba?tel=+569...&plantilla=<uuid>
 *
 * Es el paso previo a encender el primer contacto: ver el mensaje llegar antes de mandárselo a 50
 * personas. Exige el teléfono y la plantilla de forma explícita — no toma nada del CRM, para que no
 * pueda dispararse sobre una lista por accidente.
 */
export async function chatappPrueba(req: Request, res: Response) {
  const tel = String(req.query.tel ?? '').trim();
  const plantilla = String(req.query.plantilla ?? '').trim();
  if (!/^\+\d{8,15}$/.test(tel)) return res.status(400).json({ ok: false, error: 'tel debe ser E.164, ej. +56912345678' });
  if (!plantilla) return res.status(400).json({ ok: false, error: 'Falta plantilla (el UUID de ChatApp)' });
  const params = String(req.query.params ?? '').split('|').filter(Boolean);
  const r = await enviarPlantillaChatApp({ phoneE164: tel, templateId: plantilla, params });
  return res.status(r.ok ? 200 : 502).json({ ...r, tel, plantilla, params });
}
