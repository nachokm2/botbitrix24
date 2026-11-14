import type { Request, Response } from 'express';
import { config } from '../config';
import { dbFilasInternacionales } from '../store/db';
import { entradaInternacional } from '../core/internacional';
import {
  armarConversaciones,
  seccionInternacionalVisible,
  traducirVarios,
  type ConversacionInternacional,
} from '../core/conversacionesInternacionales';
import type { Editor } from './panelSesion';

/**
 * Sección «Conversaciones India» del panel: las conversaciones del modo internacional traducidas al
 * español, solo para quienes están en config.panelConversacionesInternacionales (el usuario e Ignacio,
 * 14-11-2026). Es de solo lectura: no cambia nada del bot ni de Bitrix.
 */

const DIAS = 30;

export { seccionInternacionalVisible };

function sinPermiso(res: Response) {
  return res.status(403).json({ ok: false, error: 'Esta sección no está habilitada para tu usuario.' });
}

const SIN_BASE = 'La base de datos no está disponible en este momento. Intenta de nuevo en unos minutos.';

const enlaceDeal = (dealId: number | null) =>
  dealId && config.bitrixPortalDomain ? `https://${config.bitrixPortalDomain}/crm/deal/details/${dealId}/` : null;

async function resumenDe(c: ConversacionInternacional) {
  const entrada = await entradaInternacional(c.dialogId);
  return {
    dialogId: c.dialogId,
    inicio: c.inicio,
    fin: c.fin,
    mensajes: c.turnos.length,
    motivoEntrada: entrada?.motivo ?? null,
    dealId: c.dealId,
    dealUrl: enlaceDeal(c.dealId),
    dejoCorreo: c.dejoCorreo,
    pidioAyuda: c.pidioAyuda,
    informoPago: c.informoPago,
    primerMensaje: c.turnos[0]?.cliente.slice(0, 160) ?? '',
  };
}

/** GET /panel/api/internacional/conversaciones — la lista, sin traducir (la traducción va por conversación). */
export async function panelConversacionesInternacionales(_req: Request, res: Response) {
  const editor = res.locals.editor as Editor;
  if (!seccionInternacionalVisible(editor.id)) return sinPermiso(res);
  const filas = await dbFilasInternacionales({ dias: DIAS });
  if (!filas) return res.status(503).json({ ok: false, error: SIN_BASE });
  const conversaciones = armarConversaciones(filas);
  const lista = await Promise.all(conversaciones.map(resumenDe));
  return res.json({
    ok: true,
    dias: DIAS,
    resumen: {
      personas: lista.length,
      dejaronCorreo: lista.filter((c) => c.dejoCorreo).length,
      informaronPago: lista.filter((c) => c.informoPago).length,
      pidieronAyuda: lista.filter((c) => c.pidioAyuda).length,
    },
    conversaciones: lista,
  });
}

/** GET /panel/api/internacional/conversaciones/:dialogId — una conversación completa, traducida al español. */
export async function panelConversacionInternacional(req: Request, res: Response) {
  const editor = res.locals.editor as Editor;
  if (!seccionInternacionalVisible(editor.id)) return sinPermiso(res);
  const dialogId = String(req.params.dialogId ?? '');
  if (!/^chat\d{1,12}$/.test(dialogId)) return res.status(404).json({ ok: false, error: 'Esa conversación no existe.' });
  const filas = await dbFilasInternacionales({ dias: DIAS, dialogId });
  if (!filas) return res.status(503).json({ ok: false, error: SIN_BASE });
  const [c] = armarConversaciones(filas);
  if (!c) return res.status(404).json({ ok: false, error: 'Esa conversación no existe o ya tiene más de 30 días.' });
  const traducidos = await traducirVarios(c.turnos.flatMap((t) => [t.cliente, t.bot]));
  return res.json({
    ok: true,
    ...(await resumenDe(c)),
    turnos: c.turnos.map((t, i) => ({
      ts: t.ts,
      cliente: { original: t.cliente, es: traducidos[2 * i] },
      bot: { original: t.bot, es: traducidos[2 * i + 1] },
    })),
    eventos: c.eventos,
  });
}
