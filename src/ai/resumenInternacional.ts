import { config } from '../config';
import { getState } from '../store';
import { once } from '../store/kv';
import { log } from '../log';
import { audit } from '../obs/audit';
import { dbEventosInternacionales } from '../store/db';
import { horaEnChile } from './seguimiento';
import { diaEnChile } from './resumenSemanal';
import { destinatariosInternacional, modoInternacionalConfigurado } from '../core/internacional';
import { escribirAlEquipo, cuantasConsultasAbiertas, respuestasParaLaFicha, type RespuestaEquipo } from '../core/consultasInternacionales';
import { soloMensajeDelAnuncio } from '../core/ruidoInternacional';

/**
 * Modo internacional: resumen diario a las 9:00 (hora de Chile) por el chat privado del bot, y los lunes
 * la propuesta de respuestas para la ficha. Pedido del 17-11-2026: hasta ese día, saber cuántos chats
 * llegaron, quién mostró interés o cómo iba la prueba del primer mensaje dependía de que alguien leyera
 * los registros a mano.
 */

export type FilaEvento = { dialog_id: string; ts: Date | string; type: string; detail: any; primero: Date | string };

export type Resumen = {
  nuevos: number;
  nuevosConContenido: number;
  activos: number;
  correos: number;
  enlacesDePago: number;
  pagos: number;
  consultas: number;
  recordatorios: number;
  respondidos: number;
  variantes: Record<'A' | 'B', { chats: number; volvieron: number }>;
};

const ms = (x: Date | string) => (x instanceof Date ? x.getTime() : Date.parse(String(x)));

/** Cuenta lo de las últimas 24 h y, para la prueba del primer mensaje, lo de todo el plazo leído. Pura. */
export function calcularResumen(filas: FilaEvento[], ahora = Date.now()): Resumen {
  const desde = ahora - 24 * 3600_000;
  const r: Resumen = {
    nuevos: 0,
    nuevosConContenido: 0,
    activos: 0,
    correos: 0,
    enlacesDePago: 0,
    pagos: 0,
    consultas: 0,
    recordatorios: 0,
    respondidos: 0,
    variantes: { A: { chats: 0, volvieron: 0 }, B: { chats: 0, volvieron: 0 } },
  };
  const porChat = new Map<string, { primero: number; turnos: Array<{ ts: number; msg: string; variante?: 'A' | 'B' }> }>();
  const correos = new Set<string>();
  for (const f of filas) {
    const ts = ms(f.ts);
    const d = f.detail ?? {};
    if (f.type === 'turn' && d.internacional) {
      const c = porChat.get(f.dialog_id) ?? { primero: ms(f.primero), turnos: [] };
      c.turnos.push({ ts, msg: String(d.message ?? ''), variante: d.variante === 'A' || d.variante === 'B' ? d.variante : undefined });
      porChat.set(f.dialog_id, c);
    }
    if (ts < desde) continue;
    if (f.type === 'tool_call' && d.name === 'registrar_interes_crm' && d.input?.email) correos.add(f.dialog_id);
    if (f.type === 'interes_internacional' && d.motivo === 'enlace_pago') r.enlacesDePago++;
    if (f.type === 'derivacion_internacional') d.pago ? r.pagos++ : r.consultas++;
    if (f.type === 'seguimiento' && d.internacional) r.recordatorios++;
    if (f.type === 'seguimiento_respondido') r.respondidos++;
  }
  r.correos = correos.size;
  for (const c of porChat.values()) {
    const turnos = c.turnos.sort((a, b) => a.ts - b.ts);
    if (turnos.some((t) => t.ts >= desde)) r.activos++;
    if (c.primero >= desde) {
      r.nuevos++;
      if (!soloMensajeDelAnuncio(turnos.map((t) => t.msg))) r.nuevosConContenido++;
    }
    // Prueba del primer mensaje: chats cuyo primer turno quedó marcado con su variante y que ya tuvieron
    // 3 horas para contestar. «Volvió» = escribió algo más que el anuncio, enlaces o emojis.
    const primero = turnos[0];
    if (primero?.variante && ahora - primero.ts >= 3 * 3600_000) {
      const v = r.variantes[primero.variante];
      v.chats++;
      if (!soloMensajeDelAnuncio(turnos.slice(1).map((t) => t.msg)) && turnos.length > 1) v.volvieron++;
    }
  }
  return r;
}

const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)} %` : '—');

/** El texto del resumen diario. */
export function textoResumen(r: Resumen, abiertas: number, diasPrueba: number): string {
  const { A, B } = r.variantes;
  return [
    '[B]📊 Programa internacional · últimas 24 horas[/B]',
    `Chats nuevos: ${r.nuevos} (${r.nuevosConContenido} escribieron algo más que el mensaje del anuncio)`,
    `Chats con actividad: ${r.activos}`,
    `Interesados: ${r.correos} ${r.correos === 1 ? 'correo' : 'correos'} · ${r.enlacesDePago} ${r.enlacesDePago === 1 ? 'enlace de pago enviado' : 'enlaces de pago enviados'} · ${r.pagos} ${r.pagos === 1 ? 'pago informado' : 'pagos informados'}`,
    `Consultas al equipo: ${r.consultas} ${r.consultas === 1 ? 'nueva' : 'nuevas'}; ${abiertas} sin responder${abiertas ? ' (escríbame «pendientes» para verlas)' : ''}`,
    `Recordatorios: ${r.recordatorios} enviados, ${r.respondidos} respondidos`,
    A.chats + B.chats
      ? `Prueba del primer mensaje (${diasPrueba} días): A (el de siempre) ${A.chats} chats, ${pct(A.volvieron, A.chats)} volvió a escribir · B (corto) ${B.chats} chats, ${pct(B.volvieron, B.chats)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** La propuesta semanal de respuestas para la ficha. */
export function textoPropuestaFicha(lista: RespuestaEquipo[]): string {
  return [
    `[B]📚 Para la ficha: respuestas que dio esta semana (${lista.length})[/B]`,
    ...lista.map((x, i) => `${i + 1}. ${x.pregunta.slice(0, 200)} → ${x.respuesta.slice(0, 300)}`),
    'Para que el bot las sepa sin volver a preguntarle, agréguelas en el panel (Conocimiento → Programa internacional) y publique.',
  ].join('\n');
}

const DIAS_PRUEBA = 7;

async function contexto() {
  const st = await getState();
  // Con el token del instalador, como las respuestas del bot (ver routes/botEvents.ts).
  return { auth: st.installAuth ?? st.auth, botId: st.botId ?? config.botId };
}

export async function enviarResumenInternacional(): Promise<string | null> {
  const { auth, botId } = await contexto();
  if (!auth) return null;
  const filas = await dbEventosInternacionales(DIAS_PRUEBA);
  if (!filas) return null;
  const texto = textoResumen(calcularResumen(filas), await cuantasConsultasAbiertas(), DIAS_PRUEBA);
  const avisados = await escribirAlEquipo(texto, botId, auth);
  await audit({ type: 'resumen_internacional', detail: { avisados, largo: texto.length } }).catch(() => {});
  log.info('resumen internacional enviado', { avisados });
  return texto;
}

export async function enviarPropuestaFicha(): Promise<string | null> {
  const { auth, botId } = await contexto();
  if (!auth) return null;
  const lista = await respuestasParaLaFicha();
  if (!lista.length) return null;
  const texto = textoPropuestaFicha(lista);
  const avisados = await escribirAlEquipo(texto, botId, auth);
  if (avisados) await respuestasParaLaFicha(true);
  await audit({ type: 'propuesta_ficha_internacional', detail: { avisados, respuestas: lista.length } }).catch(() => {});
  return texto;
}

const HORA_RESUMEN = 9; // hora de Chile
let intervalo: ReturnType<typeof setInterval> | null = null;

/** Todos los días a las 9:00 de Chile el resumen; los lunes, además, la propuesta para la ficha. */
export function iniciarResumenInternacional(): void {
  if (intervalo || !modoInternacionalConfigurado() || !destinatariosInternacional().length) return;
  const tick = async () => {
    try {
      const ahora = new Date();
      if (horaEnChile(ahora) !== HORA_RESUMEN) return;
      const dia = ahora.toISOString().slice(0, 10);
      // Una marca por día en Redis: con dos réplicas o un reinicio dentro de la hora, saldría dos veces.
      if (await once(`resumen_internacional:${dia}`, 48 * 3600)) await enviarResumenInternacional();
      if (diaEnChile(ahora) === 1 && (await once(`propuesta_ficha_internacional:${dia}`, 48 * 3600))) await enviarPropuestaFicha();
    } catch (e) {
      log.warn('resumen internacional falló', { err: String(e) });
    }
  };
  intervalo = setInterval(() => void tick(), 15 * 60_000);
  intervalo.unref();
  log.info('resumen internacional activo', { hora: HORA_RESUMEN, destinatarios: destinatariosInternacional().length });
}
