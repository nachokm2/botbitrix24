import { anthropic, CLASSIFIER } from './client';
import { dbTranscripcionesRecientes } from '../store/db';
import { callBitrix } from '../bitrix/client';
import { getState } from '../store';
import { once } from '../store/kv';
import { config } from '../config';
import { marca } from '../marca';
import { audit } from '../obs/audit';
import { inc, recordTokens } from '../obs/metrics';
import { horaEnChile } from './seguimiento';
import { log } from '../log';

/**
 * Revisión automática de las conversaciones del día.
 *
 * Todos los defectos que se corrigieron durante el piloto se encontraron igual: alguien leyó una
 * conversación y notó algo raro. El bot no se mira a sí mismo, así que un problema solo existe si
 * un humano se topa con él — y nadie lee 70 conversaciones al día. Esto lee todas, cada noche, y
 * deja los hallazgos donde se puedan accionar: en el panel y, si son graves, como notificación.
 *
 * Es un lector, no un juez: no cambia nada ni le escribe a nadie. Lo que encuentra se revisa.
 */

const SISTEMA = `Eres un auditor de calidad de un asistente comercial de ${marca.organizacion} que atiende por WhatsApp.
Vas a leer UNA conversación entre el asistente ("Bot") y una persona interesada ("Cliente") y detectar problemas REALES en el desempeño del asistente.

Busca SOLO estos tipos de problema:
- "sin_respuesta": el cliente preguntó algo concreto y el asistente no lo respondió, cambió de tema o respondió otra cosa.
- "dato_repetido": el asistente pidió un dato que el cliente YA le había entregado, o insistió con el mismo dato tres o más veces.
- "info_dudosa": el asistente afirmó algo concreto (precio, fecha, requisito, convalidación, duración) que no parece venir de una fuente y podría ser inventado.
- "interes_perdido": el cliente mostró interés claro en un programa y la conversación se apagó sin que el asistente pidiera sus datos ni lo derivara.
- "falla_tecnica": el asistente respondió con una disculpa genérica por un problema técnico, o con un mensaje vacío o sin sentido.
- "tono": el asistente fue brusco, excesivamente largo o robótico al punto de dañar la conversación.

Reglas:
- Si la conversación está BIEN, devuelve una lista vacía. Es el caso normal y esperable: no inventes problemas para tener algo que decir.
- Una conversación corta donde el cliente simplemente no siguió respondiendo NO es un problema.
- "gravedad" es "alta" solo si costó o pudo costar el lead; si no, "media" o "baja".
- "detalle" es UNA frase concreta que cite lo que pasó, para que alguien pueda ir a verlo.

Devuelve SOLO un JSON, sin markdown ni texto alrededor, con esta forma exacta:
{"problemas":[{"tipo":"<uno de los de arriba>","gravedad":"alta|media|baja","detalle":"<1 frase>"}]}`;

const TIPOS = new Set(['sin_respuesta', 'dato_repetido', 'info_dudosa', 'interes_perdido', 'falla_tecnica', 'tono']);
const GRAVEDADES = new Set(['alta', 'media', 'baja']);
const LARGO_MAX_TRANSCRIPCION = 12000; // una conversación muy larga se revisa por su tramo final
const CONCURRENCIA = 4;

export type Hallazgo = { tipo: string; gravedad: string; detalle: string };

/** Revisa UNA conversación. Devuelve [] si está bien o si no se pudo revisar. */
export async function revisarConversacion(texto: string): Promise<Hallazgo[]> {
  const t = texto.length > LARGO_MAX_TRANSCRIPCION ? texto.slice(-LARGO_MAX_TRANSCRIPCION) : texto;
  if (t.trim().length < 40) return []; // un saludo suelto no da para auditar
  try {
    const resp = await anthropic.messages.create({
      model: CLASSIFIER,
      max_tokens: 500,
      system: SISTEMA,
      messages: [{ role: 'user', content: `Conversación:\n${t}\n\nDevuelve el JSON.` }],
    });
    recordTokens((resp as any).usage);
    const raw = (resp.content as any[]).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    const lista = Array.isArray(json?.problemas) ? json.problemas : [];
    // Se filtra contra la lista cerrada: un tipo inventado por el modelo ensuciaría el panel y las
    // métricas por tipo, que es justo lo que hace accionable el resultado.
    return lista
      .filter((p: any) => TIPOS.has(String(p?.tipo)))
      .map((p: any) => ({
        tipo: String(p.tipo),
        gravedad: GRAVEDADES.has(String(p?.gravedad)) ? String(p.gravedad) : 'media',
        detalle: String(p?.detalle ?? '').slice(0, 400),
      }));
  } catch (e) {
    log.warn('revisarConversacion falló', { err: String(e) });
    return [];
  }
}

export type ResumenRevision = { revisadas: number; conProblemas: number; porTipo: Record<string, number>; graves: number };

/** Revisa las conversaciones con actividad reciente y deja los hallazgos en la auditoría. */
export async function revisarConversacionesRecientes(horas = 24, limite = config.revisionMaxConversaciones): Promise<ResumenRevision> {
  const filas = await dbTranscripcionesRecientes(horas, limite);
  const resumen: ResumenRevision = { revisadas: 0, conProblemas: 0, porTipo: {}, graves: 0 };
  if (!filas.length) return resumen;

  // De a 4: son llamadas al clasificador, no hay apuro, y así no se dispara un pico de rate limit
  // justo cuando el bot también está atendiendo a alguien.
  for (let i = 0; i < filas.length; i += CONCURRENCIA) {
    const lote = filas.slice(i, i + CONCURRENCIA);
    const resultados = await Promise.all(lote.map((f) => revisarConversacion(f.texto)));
    for (let j = 0; j < lote.length; j++) {
      const fila = lote[j];
      const hallazgos = resultados[j];
      resumen.revisadas++;
      if (!hallazgos.length) continue;
      resumen.conProblemas++;
      for (const h of hallazgos) {
        resumen.porTipo[h.tipo] = (resumen.porTipo[h.tipo] ?? 0) + 1;
        if (h.gravedad === 'alta') resumen.graves++;
        await audit({
          type: 'revision_hallazgo',
          dialogId: fila.dialogId,
          crmEntity: fila.crmEntity ?? undefined,
          detail: { tipo: h.tipo, gravedad: h.gravedad, detalle: h.detalle },
        });
      }
    }
  }
  inc('revision_diaria');
  log.info('revisión diaria terminada', resumen as any);
  return resumen;
}

/** Avisa al supervisor SOLO si hay algo grave: un informe que llega todos los días se deja de leer. */
async function avisarSupervisor(r: ResumenRevision): Promise<void> {
  if (!config.derivacionSupervisorId || !r.graves) return;
  const st = await getState();
  if (!st.auth) return;
  const tipos = Object.entries(r.porTipo)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t.replace(/_/g, ' ')}: ${n}`)
    .join(', ');
  const texto =
    `[B]Revisión de conversaciones[/B]\n` +
    `De ${r.revisadas} conversaciones revisadas, ${r.conProblemas} tienen algo que mirar y ${r.graves} son graves.\n` +
    (tipos ? `Tipos: ${tipos}.\n` : '') +
    `El detalle está en el panel del agente.`;
  await callBitrix('im.notify.personal.add', { USER_ID: config.derivacionSupervisorId, MESSAGE: texto }, st.auth).catch((e) =>
    log.warn('revisión diaria: no se pudo notificar', { err: String(e) }),
  );
}

let intervalo: ReturnType<typeof setInterval> | null = null;
const CHEQUEO_MIN = 15;

/** Corre la revisión una vez al día, a la hora configurada (hora de Chile). */
export function iniciarRevisionDiaria(): void {
  if (config.revisionDiariaHora < 0 || intervalo) return;
  const tick = async () => {
    try {
      if (horaEnChile(new Date()) !== config.revisionDiariaHora) return;
      // La marca del día va por Redis: con dos réplicas o un reinicio dentro de la misma hora, la
      // revisión correría dos veces y duplicaría los hallazgos.
      const dia = new Date().toISOString().slice(0, 10);
      if (!(await once(`revision:${dia}`, 36 * 3600))) return;
      const r = await revisarConversacionesRecientes();
      await avisarSupervisor(r);
    } catch (e) {
      log.warn('revisión diaria falló', { err: String(e) });
    }
  };
  intervalo = setInterval(() => void tick(), CHEQUEO_MIN * 60_000);
  intervalo.unref();
  log.info('revisión diaria activa', { hora: config.revisionDiariaHora, max: config.revisionMaxConversaciones });
}
