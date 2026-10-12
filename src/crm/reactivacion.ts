import { callCrm } from '../bitrix/client';
import { dbConversacionesFrias } from '../store/db';
import { enviarPlantillaWhatsApp } from '../whatsapp/template';
import { estaExcluido } from './exclusion';
import { aE164, paisPermitido } from './primerContacto';
import { getUsuarios } from './directory';
import { once, getRedisClient } from '../store/kv';
import { getState, type Auth } from '../store';
import { config } from '../config';
import { marca } from '../marca';
import { audit } from '../obs/audit';
import { horaEnChile } from '../ai/seguimiento';
import { log } from '../log';

/**
 * Reactivación de conversaciones frías.
 *
 * Distinto del primer contacto: acá la persona SÍ habló con el bot, dejó datos y después se apagó.
 * Es el público más barato de recuperar, porque el interés ya está demostrado.
 *
 * Hace falta una vía aparte porque el seguimiento automático solo alcanza dentro de las 24 horas
 * desde la última interacción; pasado ese plazo WhatsApp no deja mandar texto libre y hay que usar
 * una plantilla, igual que en el primer contacto.
 *
 * Comparte todos los frenos del primer contacto —lista de exclusión, países permitidos, horario
 * hábil, tope diario, una sola vez por persona— porque los motivos para tenerlos son los mismos.
 */

export type Frio = {
  dialogId: string;
  dealId: number;
  contactId: number;
  nombre: string;
  telefono: string;
  programa: string;
  asesor: string;
  diasSinHablar: number;
};

const LOTE = 50;
const CLAVE_REACTIVADO = (contactId: number) => `reactivacion:contacto:${contactId}`;
const CLAVE_CUPO = (dia: string) => `reactivacion:dia:${dia}`;

/** Conversaciones frías con todo lo necesario para escribirles. */
export async function candidatosReactivacion(auth: Auth, limite = 100): Promise<Frio[]> {
  const frias = await dbConversacionesFrias(config.reactivacionDiasMin, config.reactivacionDiasMax, limite);
  if (!frias.length) return [];

  const porDeal = new Map<number, Record<string, any>>();
  const ids = frias.map((f) => f.dealId);
  for (let i = 0; i < ids.length; i += LOTE) {
    try {
      const deals = await callCrm<Array<Record<string, any>>>(
        'crm.deal.list',
        {
          filter: { '@ID': ids.slice(i, i + LOTE) },
          select: ['ID', 'CONTACT_ID', 'TITLE', 'ASSIGNED_BY_ID', ...(config.ufPrograma ? [config.ufPrograma] : [])],
        },
        auth,
      );
      for (const d of Array.isArray(deals) ? deals : []) porDeal.set(Number(d.ID), d);
    } catch (e) {
      log.warn('candidatosReactivacion: crm.deal.list falló', { err: String(e) });
    }
  }

  const contactIds = [...new Set([...porDeal.values()].map((d) => Number(d.CONTACT_ID)).filter((n) => n > 0))];
  const contactos = new Map<number, { nombre: string; telefono: string }>();
  for (let i = 0; i < contactIds.length; i += LOTE) {
    try {
      const filas = await callCrm<Array<Record<string, any>>>(
        'crm.contact.list',
        { filter: { '@ID': contactIds.slice(i, i + LOTE) }, select: ['ID', 'NAME', 'PHONE'] },
        auth,
      );
      for (const c of Array.isArray(filas) ? filas : []) {
        const tel = aE164(String(c.PHONE?.[0]?.VALUE ?? ''));
        if (tel && paisPermitido(tel)) contactos.set(Number(c.ID), { nombre: String(c.NAME ?? '').trim(), telefono: tel });
      }
    } catch (e) {
      log.warn('candidatosReactivacion: crm.contact.list falló', { err: String(e) });
    }
  }

  const asesores = new Map<number, string>();
  const idsAsesor = [...new Set([...porDeal.values()].map((d) => Number(d.ASSIGNED_BY_ID ?? 0)).filter((n) => n > 0))];
  if (idsAsesor.length) {
    try {
      for (const u of await getUsuarios(idsAsesor, auth)) asesores.set(u.id, u.nombre);
    } catch (e) {
      log.warn('candidatosReactivacion: no se pudieron resolver los asesores', { err: String(e) });
    }
  }

  const vistos = new Set<number>();
  const out: Frio[] = [];
  for (const f of frias) {
    const d = porDeal.get(f.dealId);
    if (!d) continue;
    const contactId = Number(d.CONTACT_ID ?? 0);
    const c = contactos.get(contactId);
    if (!c || vistos.has(contactId)) continue; // una persona, un mensaje
    vistos.add(contactId);
    out.push({
      dialogId: f.dialogId,
      dealId: f.dealId,
      contactId,
      nombre: c.nombre,
      telefono: c.telefono,
      programa: String((config.ufPrograma && d[config.ufPrograma]) || d.TITLE || '').trim(),
      asesor: asesores.get(Number(d.ASSIGNED_BY_ID ?? 0)) ?? '',
      diasSinHablar: Math.round((Date.now() - new Date(f.ultimoTurno).getTime()) / 86400_000),
    });
  }
  return out;
}

export type MotivoDescarteReact = 'desactivado' | 'sin_plantilla' | 'fuera_de_horario' | 'ya_reactivado' | 'excluido' | 'tope_diario' | 'error_envio';

async function dentroDelCupo(): Promise<boolean> {
  const max = config.reactivacionMaxDiario;
  if (max <= 0) return false;
  const dia = new Date().toISOString().slice(0, 10);
  const r = getRedisClient();
  if (r) {
    const n = await r.incr(CLAVE_CUPO(dia));
    if (n === 1) await r.expire(CLAVE_CUPO(dia), 36 * 3600).catch(() => {});
    return n <= max;
  }
  return true;
}

export async function reactivar(f: Frio): Promise<{ enviado: boolean; motivo?: MotivoDescarteReact }> {
  if (!config.reactivacionActiva) return { enviado: false, motivo: 'desactivado' };
  if (!config.reactivacionPlantillas.length) return { enviado: false, motivo: 'sin_plantilla' };
  const hora = horaEnChile(new Date());
  if (hora < config.seguimientoHoraInicio || hora >= config.seguimientoHoraFin) {
    return { enviado: false, motivo: 'fuera_de_horario' };
  }
  if (await estaExcluido({ telefono: f.telefono, contactId: f.contactId })) return { enviado: false, motivo: 'excluido' };
  if (!(await once(CLAVE_REACTIVADO(f.contactId), 180 * 24 * 3600))) return { enviado: false, motivo: 'ya_reactivado' };
  if (!(await dentroDelCupo())) return { enviado: false, motivo: 'tope_diario' };

  const plantilla = config.reactivacionPlantillas[f.contactId % config.reactivacionPlantillas.length];
  const params = config.primerContactoParams.map((t) =>
    t === 'nombre' ? f.nombre || 'hola' : t === 'programa' ? f.programa : t === 'asesor' ? f.asesor || marca.botNombre : t === 'organizacion' ? marca.organizacion : '',
  );
  const r = await enviarPlantillaWhatsApp({ phoneE164: f.telefono, template: plantilla, lang: config.primerContactoIdioma, params });
  await audit({
    type: 'reactivacion',
    dialogId: f.dialogId,
    crmEntity: `deal#${f.dealId}`,
    detail: { ok: r.ok, error: r.ok ? undefined : r.error, plantilla, diasSinHablar: f.diasSinHablar },
  });
  if (!r.ok) {
    log.warn('reactivación falló', { dealId: f.dealId, err: r.error });
    return { enviado: false, motivo: 'error_envio' };
  }
  return { enviado: true };
}

export type ResumenReactivacion = { candidatos: number; enviados: number; descartados: Record<string, number>; muestra: Frio[] };

export async function correrReactivacion(auth: Auth, opts: { simular?: boolean } = {}): Promise<ResumenReactivacion> {
  const candidatos = await candidatosReactivacion(auth);
  const resumen: ResumenReactivacion = { candidatos: candidatos.length, enviados: 0, descartados: {}, muestra: candidatos.slice(0, 10) };
  if (opts.simular) return resumen;
  for (const f of candidatos) {
    const r = await reactivar(f);
    if (r.enviado) resumen.enviados++;
    else resumen.descartados[r.motivo ?? '?'] = (resumen.descartados[r.motivo ?? '?'] ?? 0) + 1;
    if (r.motivo === 'desactivado' || r.motivo === 'sin_plantilla' || r.motivo === 'tope_diario') break;
  }
  log.info('reactivación: corrida terminada', resumen as any);
  return resumen;
}

let intervalo: ReturnType<typeof setInterval> | null = null;

export function iniciarReactivacion(): void {
  if (!config.reactivacionActiva || intervalo) return;
  if (!config.reactivacionPlantillas.length) {
    log.warn('reactivación: activa pero SIN plantilla; no se arranca');
    return;
  }
  const tick = async () => {
    try {
      if (horaEnChile(new Date()) !== config.reactivacionHora) return;
      const dia = new Date().toISOString().slice(0, 10);
      if (!(await once(`reactivacion:corrida:${dia}`, 36 * 3600))) return;
      const st = await getState();
      if (!st.auth) return;
      await correrReactivacion(st.auth);
    } catch (e) {
      log.warn('reactivación: la corrida diaria falló', { err: String(e) });
    }
  };
  intervalo = setInterval(() => void tick(), 30 * 60_000);
  intervalo.unref();
  log.info('reactivación activa', { hora: config.reactivacionHora, maxDiario: config.reactivacionMaxDiario });
}
