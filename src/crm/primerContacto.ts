import { callCrm } from '../bitrix/client';
import { dbDialogosConDeal } from '../store/db';
import { enviarPlantillaWhatsApp } from '../whatsapp/template';
import { once, getRedisClient } from '../store/kv';
import { config } from '../config';
import { audit } from '../obs/audit';
import { horaEnChile } from '../ai/seguimiento';
import { getState, type Auth } from '../store';
import { log } from '../log';

/**
 * Primer contacto con los leads que entraron y NUNCA escribieron.
 *
 * El dato que lo motiva: en el piloto entraron ~800 leads al embudo y el bot conversó con 81. Los
 * otros 719 dejaron sus datos en un formulario o una campaña y nadie volvió a hablarles, porque el
 * bot solo sabe responder: si el cliente no abre la conversación, no pasa nada.
 *
 * ESTE MÓDULO NO ENVÍA NADA MIENTRAS PRIMER_CONTACTO_ACTIVO no sea "true". Está así a propósito:
 * escribirle primero a alguien no es lo mismo que responderle. Requiere una plantilla aprobada por
 * Meta (fuera de las 24 horas no se puede mandar texto libre), una decisión sobre a cuántos y con
 * qué frecuencia, y claridad sobre el consentimiento con que esos datos se recogieron. Hasta que
 * eso esté resuelto, `correrPrimerContacto` sirve para VER a quiénes se les escribiría.
 */

export type Candidato = {
  dealId: number;
  contactId: number;
  nombre: string;
  telefono: string;
  programa: string;
  creado: string;
};

export type MotivoDescarte = 'desactivado' | 'sin_plantilla' | 'fuera_de_horario' | 'ya_contactado' | 'tope_diario' | 'error_envio';
export type Resumen = {
  candidatos: number;
  enviados: number;
  descartados: Record<string, number>;
  muestra: Candidato[];
};

const LOTE = 50; // crm.*.list devuelve como máximo 50 filas por página
// La marca de "ya se le escribió" va por CONTACTO, no por negociación: medido en Carver, 4.433
// negociaciones de los últimos 30 días corresponden a 4.305 personas. Llevarla por negociación le
// mandaba dos mensajes a quien llenó dos formularios.
const CLAVE_CONTACTADO = (contactId: number) => `primer-contacto:contacto:${contactId}`;
const CLAVE_CUPO_DIARIO = (dia: string) => `primer-contacto:dia:${dia}`;

/**
 * Normaliza a E.164. Un número ya internacional se respeta tal cual.
 *
 * Con `prefijoPorDefecto` vacío, un número SIN prefijo se descarta en vez de adivinarle el país.
 * Es lo correcto para una marca internacional: los leads de Carver son 36% chilenos, 31%
 * colombianos, 12% ecuatorianos y 10% de EE.UU., así que asumir +56 le mandaría el mensaje a un
 * chileno cualquiera que no tiene nada que ver. Perder un contacto ambiguo es más barato que eso.
 */
export function aE164(raw: string, prefijoPorDefecto = config.primerContactoPrefijoPais): string | null {
  const s = String(raw ?? '').replace(/[\s()\-.]/g, '');
  if (!s) return null;
  if (s.startsWith('00')) return validoE164(`+${s.slice(2)}`);
  if (s.startsWith('+')) return validoE164(s);
  if (!prefijoPorDefecto) return null; // sin país conocido no se arriesga un destinatario equivocado
  return validoE164(`${prefijoPorDefecto}${s.replace(/^0+/, '')}`);
}

const validoE164 = (e: string): string | null => (/^\+\d{8,15}$/.test(e) ? e : null);

/** Negociaciones creadas en los últimos `dias` con las que el bot NUNCA conversó. */
export async function candidatosPrimerContacto(auth: Auth, dias = 7, limite = 200): Promise<Candidato[]> {
  const desde = new Date(Date.now() - dias * 86400_000).toISOString().slice(0, 10);
  const filtro: Record<string, unknown> = { '>=DATE_CREATE': desde };
  if (config.primerContactoCategorias.length) filtro['@CATEGORY_ID'] = config.primerContactoCategorias;

  const deals: Array<Record<string, any>> = [];
  for (let start = 0; start < limite; start += LOTE) {
    try {
      const pagina = await callCrm<Array<Record<string, any>>>(
        'crm.deal.list',
        {
          filter: filtro,
          select: ['ID', 'CONTACT_ID', 'TITLE', 'DATE_CREATE', ...(config.ufPrograma ? [config.ufPrograma] : [])],
          order: { DATE_CREATE: 'DESC' },
          start,
        },
        auth,
      );
      if (!Array.isArray(pagina) || !pagina.length) break;
      deals.push(...pagina);
      if (pagina.length < LOTE) break;
    } catch (e) {
      log.warn('candidatosPrimerContacto: crm.deal.list falló', { err: String(e), start });
      break;
    }
  }
  if (!deals.length) return [];

  // El bot ya conversó con estos: no son "nunca escribieron".
  const conversados = new Set((await dbDialogosConDeal()).map((x) => x.dealId));
  const pendientes = deals.filter((d) => d.CONTACT_ID && !conversados.has(Number(d.ID)));
  if (!pendientes.length) return [];

  // Los teléfonos viven en el contacto, no en la negociación: se piden de a 50 en vez de uno por uno.
  const contactos = new Map<number, { nombre: string; telefono: string }>();
  const ids = [...new Set(pendientes.map((d) => Number(d.CONTACT_ID)))];
  for (let i = 0; i < ids.length; i += LOTE) {
    try {
      const filas = await callCrm<Array<Record<string, any>>>(
        'crm.contact.list',
        { filter: { '@ID': ids.slice(i, i + LOTE) }, select: ['ID', 'NAME', 'PHONE'] },
        auth,
      );
      for (const c of Array.isArray(filas) ? filas : []) {
        const tel = aE164(String(c.PHONE?.[0]?.VALUE ?? ''));
        if (tel) contactos.set(Number(c.ID), { nombre: String(c.NAME ?? '').trim(), telefono: tel });
      }
    } catch (e) {
      log.warn('candidatosPrimerContacto: crm.contact.list falló', { err: String(e) });
    }
  }

  // Una persona, un mensaje: si llenó dos formularios tiene dos negociaciones, y se queda con la
  // más reciente (la lista ya viene ordenada por fecha descendente).
  const yaVisto = new Set<number>();
  return pendientes
    .filter((d) => {
      const id = Number(d.CONTACT_ID);
      if (yaVisto.has(id)) return false;
      yaVisto.add(id);
      return true;
    })
    .map((d): Candidato | null => {
      const c = contactos.get(Number(d.CONTACT_ID));
      if (!c) return null; // sin teléfono utilizable no hay a quién escribirle
      return {
        dealId: Number(d.ID),
        contactId: Number(d.CONTACT_ID),
        nombre: c.nombre,
        telefono: c.telefono,
        programa: String((config.ufPrograma && d[config.ufPrograma]) || d.TITLE || '').trim(),
        creado: String(d.DATE_CREATE ?? ''),
      };
    })
    .filter((x): x is Candidato => x !== null);
}

/** Intenta el primer contacto con UNA persona. Todas las puertas están cerradas por defecto. */
export async function enviarPrimerContacto(c: Candidato): Promise<{ enviado: boolean; motivo?: MotivoDescarte }> {
  if (!config.primerContactoActivo) return { enviado: false, motivo: 'desactivado' };
  if (!config.primerContactoPlantilla) return { enviado: false, motivo: 'sin_plantilla' };

  // Escribir primero a las 3 de la mañana es peor que no escribir: mismo horario que el seguimiento.
  const hora = horaEnChile(new Date());
  if (hora < config.seguimientoHoraInicio || hora >= config.seguimientoHoraFin) {
    return { enviado: false, motivo: 'fuera_de_horario' };
  }
  // Una sola vez por negociación, para siempre: insistir a quien nunca contestó es spam.
  if (!(await once(CLAVE_CONTACTADO(c.contactId), 365 * 24 * 3600))) return { enviado: false, motivo: 'ya_contactado' };
  if (!(await dentroDelCupoDiario())) return { enviado: false, motivo: 'tope_diario' };

  const r = await enviarPlantillaWhatsApp({
    phoneE164: c.telefono,
    template: config.primerContactoPlantilla,
    lang: config.primerContactoIdioma,
    params: [c.nombre || 'hola', c.programa],
  });
  await audit({
    type: 'primer_contacto',
    crmEntity: `deal#${c.dealId}`,
    detail: { ok: r.ok, error: r.ok ? undefined : r.error, programa: c.programa },
  });
  if (!r.ok) {
    log.warn('primer contacto falló', { dealId: c.dealId, err: r.error });
    return { enviado: false, motivo: 'error_envio' };
  }
  return { enviado: true };
}

let cupoLocal = { dia: '', usados: 0 };

/** Cupo diario: un contador, no una llave por envío. Con Redis vive ahí, para que el tope sea del
 *  servicio y no de cada réplica; sin Redis cae a memoria, que es lo que hay en desarrollo. */
async function dentroDelCupoDiario(): Promise<boolean> {
  const max = config.primerContactoMaxDiario;
  if (max <= 0) return false;
  const dia = new Date().toISOString().slice(0, 10);
  const r = getRedisClient();
  if (r) {
    const clave = CLAVE_CUPO_DIARIO(dia);
    const n = await r.incr(clave);
    if (n === 1) await r.expire(clave, 36 * 3600).catch(() => {});
    return n <= max;
  }
  if (cupoLocal.dia !== dia) cupoLocal = { dia, usados: 0 };
  cupoLocal.usados++;
  return cupoLocal.usados <= max;
}

/** Corrida completa. `simular` recorre todo SIN enviar: es para ver a quiénes se les escribiría. */
export async function correrPrimerContacto(auth: Auth, opts: { dias?: number; simular?: boolean } = {}): Promise<Resumen> {
  const candidatos = await candidatosPrimerContacto(auth, opts.dias ?? config.primerContactoDias);
  const resumen: Resumen = { candidatos: candidatos.length, enviados: 0, descartados: {}, muestra: candidatos.slice(0, 10) };
  if (opts.simular) return resumen;

  for (const c of candidatos) {
    const r = await enviarPrimerContacto(c);
    if (r.enviado) resumen.enviados++;
    else resumen.descartados[r.motivo ?? 'desconocido'] = (resumen.descartados[r.motivo ?? 'desconocido'] ?? 0) + 1;
    // Si está apagado o se acabó el cupo, el resto va a dar lo mismo: no se sigue golpeando Bitrix.
    if (r.motivo === 'desactivado' || r.motivo === 'sin_plantilla' || r.motivo === 'tope_diario') break;
  }
  log.info('primer contacto: corrida terminada', resumen as any);
  return resumen;
}

let intervalo: ReturnType<typeof setInterval> | null = null;
const CHEQUEO_MIN = 30;

/**
 * Corre el primer contacto una vez al día, a la hora configurada (hora de Chile).
 *
 * No arranca si no está activo: así el servicio no gasta llamadas a Bitrix revisando candidatos a
 * los que nunca les va a escribir. Encenderlo es cambiar PRIMER_CONTACTO_ACTIVO y reiniciar.
 */
export function iniciarPrimerContacto(): void {
  if (!config.primerContactoActivo || intervalo) return;
  if (!config.primerContactoPlantilla) {
    log.warn('primer contacto: activo pero SIN plantilla configurada; no se arranca');
    return;
  }
  const tick = async () => {
    try {
      if (horaEnChile(new Date()) !== config.primerContactoHora) return;
      // Una marca por día en Redis: con dos réplicas o un reinicio dentro de la misma hora, la
      // tanda saldría dos veces y el tope diario no alcanzaría a contenerla.
      const dia = new Date().toISOString().slice(0, 10);
      if (!(await once(`primer-contacto:corrida:${dia}`, 36 * 3600))) return;
      const st = await getState();
      if (!st.auth) return log.warn('primer contacto: sin auth de Bitrix');
      await correrPrimerContacto(st.auth);
    } catch (e) {
      log.warn('primer contacto: la corrida diaria falló', { err: String(e) });
    }
  };
  intervalo = setInterval(() => void tick(), CHEQUEO_MIN * 60_000);
  intervalo.unref();
  log.info('primer contacto activo', {
    hora: config.primerContactoHora,
    maxDiario: config.primerContactoMaxDiario,
    dias: config.primerContactoDias,
    embudos: config.primerContactoCategorias,
    plantilla: config.primerContactoPlantilla,
  });
}
