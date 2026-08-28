import { anthropic, CLASSIFIER } from './client';
import { getHistory, setHistory } from './memory';
import { transcript } from './briefing';
import { getSession } from '../session';
import { callBitrix } from '../bitrix/client';
import { getRedisClient } from '../store/kv';
import { getState } from '../store';
import { config } from '../config';
import { recordTokens, inc } from '../obs/metrics';
import { audit } from '../obs/audit';
import { log } from '../log';

// Seguimiento automático (WhatsApp/Open Lines): si el bot respondió y el cliente quedó en silencio
// SEGUIMIENTO_HORAS, se le manda UN mensaje de seguimiento (generado por IA a partir de la propia
// conversación). Se agenda con un ZSET en Redis (dialogId -> vencimiento) que un barrido periódico
// recorre — mismo patrón que store/db.ts:startRetentionSweep. Solo WhatsApp: es el único canal donde
// el bot puede escribirle a alguien por iniciativa propia (Web Chat/Instagram/Messenger no tienen
// una forma de "empujar" un mensaje al visitante fuera de una respuesta).

const DUE_KEY = 'seguimiento:due';

const SEGUIMIENTO_SYSTEM = `Eres Sofía, asesora comercial de Postgrados de la Universidad Autónoma de Chile. El cliente no ha respondido desde tu último mensaje. Escribe UN mensaje de seguimiento breve (1 a 3 frases), cálido y natural, en español de Chile: retoma el hilo de la conversación (el programa o tema del que hablaban) y ofrece seguir ayudando. No repitas literalmente algo que ya dijiste, no inventes datos ni programas, no uses un saludo formal tipo "Estimado/a". Devuelve SOLO el mensaje, sin comillas ni explicación.`;

/** Programa (o reprograma) el seguimiento de un diálogo, N horas desde AHORA (se llama tras cada
 *  respuesta del bot, así que el plazo siempre corre desde la ÚLTIMA vez que el bot habló). No hace
 *  nada si la regla está desactivada, si no hay Redis, o si un humano ya tomó la conversación. */
export async function programarSeguimiento(dialogId: string): Promise<void> {
  const r = getRedisClient();
  if (!r || config.seguimientoHoras <= 0) return;
  try {
    const sess = await getSession(dialogId);
    if (sess.humanTookOver) return;
    await r.zadd(DUE_KEY, Date.now() + config.seguimientoHoras * 3600_000, dialogId);
  } catch (e) {
    log.warn('programarSeguimiento falló', { err: String(e), dialogId });
  }
}

/** Cancela el seguimiento pendiente de un diálogo (un humano tomó la conversación). */
export async function cancelarSeguimiento(dialogId: string): Promise<void> {
  const r = getRedisClient();
  if (!r) return;
  try {
    await r.zrem(DUE_KEY, dialogId);
  } catch (e) {
    log.warn('cancelarSeguimiento falló', { err: String(e), dialogId });
  }
}

async function generarMensajeSeguimiento(dialogId: string): Promise<string | null> {
  const t = transcript(await getHistory(dialogId));
  if (t.length < 5) return null;
  const resp = await anthropic.messages.create({
    model: CLASSIFIER,
    max_tokens: 200,
    system: SEGUIMIENTO_SYSTEM,
    messages: [{ role: 'user', content: `Conversación:\n${t}\n\nEscribe el mensaje de seguimiento.` }],
  });
  recordTokens((resp as any).usage);
  const texto = (resp.content as any[]).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return texto || null;
}

/** Recorre los diálogos vencidos y envía el seguimiento (una sola vez cada uno — ZREM es el reclamo
 *  atómico: si hay más de una réplica corriendo el barrido, solo una logra "borrar y procesar"). */
export async function barrerSeguimientosVencidos(): Promise<void> {
  const r = getRedisClient();
  if (!r) return;
  let vencidos: string[] = [];
  try {
    vencidos = await r.zrangebyscore(DUE_KEY, '-inf', Date.now());
  } catch (e) {
    log.warn('barrerSeguimientosVencidos: zrangebyscore falló', { err: String(e) });
    return;
  }
  if (!vencidos.length) return;

  const st = await getState();
  const auth = st.auth;
  const botId = st.botId ?? config.botId;
  if (!auth || !botId) return; // sin auth/bot no se puede enviar nada todavía

  for (const dialogId of vencidos) {
    const reclamado = await r.zrem(DUE_KEY, dialogId).catch(() => 0);
    if (!reclamado) continue; // otra réplica ya lo tomó

    try {
      const sess = await getSession(dialogId);
      if (sess.humanTookOver) continue; // un humano ya tomó la conversación mientras tanto

      const mensaje = await generarMensajeSeguimiento(dialogId);
      if (!mensaje) continue;

      await callBitrix('imbot.message.add', { BOT_ID: botId, DIALOG_ID: dialogId, MESSAGE: mensaje }, auth);
      const history = await getHistory(dialogId);
      await setHistory(dialogId, [...history, { role: 'assistant', content: mensaje }]);
      inc('seguimiento');
      await audit({ type: 'seguimiento', dialogId, detail: { mensaje } });
      log.info('seguimiento enviado', { dialogId });
    } catch (e) {
      log.warn('barrerSeguimientosVencidos: falló para un diálogo', { err: String(e), dialogId });
    }
  }
}

let intervalo: ReturnType<typeof setInterval> | null = null;

/** Arranca el barrido periódico (cada SEGUIMIENTO_INTERVALO_MIN minutos). No-op sin Redis o con la
 *  regla desactivada (SEGUIMIENTO_HORAS=0), y no se vuelve a arrancar si ya está corriendo. */
export function iniciarBarridoSeguimientos(): void {
  if (!getRedisClient() || config.seguimientoHoras <= 0 || intervalo) return;
  intervalo = setInterval(() => {
    barrerSeguimientosVencidos().catch((e) => log.warn('barrerSeguimientosVencidos (intervalo) falló', { err: String(e) }));
  }, config.seguimientoIntervaloMin * 60_000);
  intervalo.unref();
  log.info('seguimiento: barrido activo', { horas: config.seguimientoHoras, intervaloMin: config.seguimientoIntervaloMin });
}
