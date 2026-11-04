import { anthropic, REASONER } from './client';
import { recortar } from '../core/textoSeguro';
import { dbEmbudoCierre, dbMejorasPrevias, type EmbudoCierre } from '../store/db';
import { vistaPorAsesor } from '../crm/vistaAsesores';
import { callBitrix } from '../bitrix/client';
import { getState } from '../store';
import { config } from '../config';
import { marca } from '../marca';
import { audit } from '../obs/audit';
import { recordTokens } from '../obs/metrics';
import { log } from '../log';
import type { CasoRevisado, ResumenRevision } from './revisionDiaria';

/**
 * Control diario de cierre, empujado a Bitrix al terminar la revisión de la mañana.
 *
 * La revisión diaria deja hallazgos sueltos en el panel y el resumen semanal llega los lunes: lo que
 * se podía cambiar hoy se veía una semana después. Las mejoras que más movieron la conversión (las
 * rondas del 26-10 al 03-11-2026) salieron de leer los chats donde se perdió a alguien y preguntarse
 * qué había que cambiar. Esto hace esa lectura cada mañana: cómo cerró el bot en las últimas 24 horas,
 * dónde se perdió gente, qué falló y hasta tres cambios concretos, cada uno con su evidencia.
 *
 * Igual que la revisión, es un lector: propone, no cambia nada.
 */

const ANALISTA = `Eres quien mejora la conversión del asistente comercial de ${marca.organizacion}, que atiende por WhatsApp a personas interesadas en sus programas. Cada mañana lees lo que pasó en las últimas 24 horas y propones qué cambiar para que más interesados lleguen a matricularse.

Recibes el embudo del día (con la semana previa de referencia), los problemas que marcó la revisión automática, las mejoras propuestas los días anteriores y algunas conversaciones: primero aquellas donde se perdió a alguien, después algunas que no pasaron del primer intercambio.

Propón como máximo 3 mejoras, de mayor a menor impacto en matrículas. Cada una con:
- "mejora": qué cambiar, concreto, en una o dos frases que alguien pueda ejecutar hoy. Nada de consejos generales como "mejorar la empatía".
- "evidencia": el chat (por ejemplo "chat1572073") o el número del embudo que la justifica.
- "donde": quién la hace. "bot" si es un cambio en cómo responde el asistente (lo hace el equipo técnico); "panel" si falta o está mal un dato que se edita en el panel de configuración (programas, precios, conocimiento, comportamiento); "asesores" si depende del seguimiento de una persona del equipo; "direccion" si es una decisión de la institución.
- "repetida": true si es la misma que ya se propuso un día anterior y el problema sigue; si no, false.

Reglas:
- Solo lo que se vea en el material. Si el día fue bueno o hay muy poco para concluir, devuelve menos mejoras o ninguna: no rellenes.
- No propongas que el asistente invente precios, fechas, requisitos ni beneficios, ni que prometa lo que la institución no ofrece.
- Una persona que no siguió respondiendo después de una buena respuesta no es por sí sola un error: busca el patrón, no el caso suelto.
- Español neutro, frases cortas.

Devuelve SOLO un JSON, sin markdown ni texto alrededor, con esta forma exacta:
{"mejoras":[{"mejora":"...","evidencia":"...","donde":"bot|panel|asesores|direccion","repetida":false}]}`;

const DONDE: Record<string, string> = { bot: 'Bot', panel: 'Panel', asesores: 'Asesores', direccion: 'Dirección' };
const TIPO: Record<string, string> = {
  interes_perdido: 'Interés perdido',
  sin_respuesta: 'Sin respuesta',
  dato_repetido: 'Dato repetido',
  info_dudosa: 'Información dudosa',
  falla_tecnica: 'Falla técnica',
  tono: 'Tono',
};
const LARGO_POR_CONVERSACION = 3000; // de cada chat se lee el tramo final: ahí es donde se pierde a la persona
const MAX_EJEMPLOS = 3;

export type Mejora = { mejora: string; evidencia: string; donde: string; repetida: boolean };

export type DatosControl = {
  fecha: string;
  cur: EmbudoCierre;
  semana: EmbudoCierre; // los 7 días previos, de referencia
  revisadas: number;
  unIntercambio: number;
  porTipo: Record<string, number>;
  graves: number;
  ejemplos: Array<{ tipo: string; detalle: string; dialogId: string; crmEntity: string | null }>;
  mejoras: Mejora[] | null; // null = el análisis falló, [] = no hubo nada que proponer
  sinTrabajar: Array<{ nombre: string; pendientes: number }>;
};

const pct = (parte: number, total: number) => (total > 0 ? Math.round((parte / total) * 100) : 0);
const unDecimal = (n: number) => n.toLocaleString('es-CL', { maximumFractionDigits: 1 });

/** "martes, 4 de noviembre", en la hora de Chile. */
export function fechaEnChile(d: Date): string {
  return new Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago', weekday: 'long', day: 'numeric', month: 'long' }).format(d);
}

/** Enlaces para ir a ver un caso desde la notificación: el chat y, si hay, la negociación o el lead. */
function enlaces(dominio: string, dialogId: string, crmEntity: string | null): string {
  if (!dominio) return dialogId;
  const l = [`[URL=https://${dominio}/online/?IM_DIALOG=${dialogId}]abrir chat[/URL]`];
  const m = /^(deal|lead)#(\d+)$/.exec(crmEntity ?? '');
  if (m) l.push(`[URL=https://${dominio}/crm/${m[1]}/details/${m[2]}/]${m[1] === 'deal' ? 'negociación' : 'lead'} #${m[2]}[/URL]`);
  return l.join(' · ');
}

/** Los "chat123" que cita el análisis como evidencia se vuelven enlaces al chat. */
function enlazarChats(texto: string, dominio: string): string {
  return dominio ? texto.replace(/\bchat(\d+)\b/g, `[URL=https://${dominio}/online/?IM_DIALOG=chat$1]chat$1[/URL]`) : texto;
}

/** Arma el texto del mensaje. Pura, para poder revisar la redacción sin tocar Bitrix. */
export function redactarControl(d: DatosControl, dominio = ''): string {
  const l: string[] = [`[B]Control diario — agente ${marca.etiquetaPanel}[/B] · ${d.fecha}`];
  const { cur, semana } = d;
  if (!cur.atendidas && !d.revisadas) {
    l.push('En las últimas 24 horas el bot no atendió conversaciones.');
    return l.join('\n');
  }

  // La semana previa va al lado de cada porcentaje: un día suelto no dice si el bot mejora o empeora.
  const tasa = (p: number, pp: number) => `${pct(p, cur.atendidas)}%` + (semana.atendidas ? `; semana previa ${pct(pp, semana.atendidas)}%` : '');
  l.push(
    `[B]Cómo cerró (últimas 24 h):[/B] ${cur.atendidas} conversaciones. ` +
      `Datos capturados en ${cur.captura} (${tasa(cur.captura, semana.captura)}), ` +
      `derivadas a un asesor ${cur.escal} (${tasa(cur.escal, semana.escal)}).` +
      (marca.matriculaEnChat ? ` Matrícula en el chat: ${cur.matriculaInicia} con ficha iniciada y ${cur.enlacePago} con enlace de pago.` : ''),
  );

  const fugas: string[] = [];
  if (d.unIntercambio) fugas.push(`${d.unIntercambio} de ${d.revisadas} revisadas quedaron en un solo intercambio`);
  fugas.push(
    `${cur.interesPerdido} con interés claro se fueron sin dejar datos ni pasar a un asesor` +
      (semana.atendidas ? ` (semana previa: ${unDecimal(semana.interesPerdido / 7)} al día)` : ''),
  );
  l.push(`[B]Dónde se perdió gente:[/B] ${fugas.join('; ')}.`);

  const tipos = Object.entries(d.porTipo)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${(TIPO[t] ?? t).toLowerCase()} ${n}`);
  if (tipos.length) {
    l.push(`[B]Qué falló:[/B] ${tipos.join(', ')}${d.graves ? ` (${d.graves} graves)` : ''}.`);
    for (const e of d.ejemplos) l.push(`• ${TIPO[e.tipo] ?? e.tipo}: ${e.detalle} — ${enlaces(dominio, e.dialogId, e.crmEntity)}`);
  } else {
    l.push('[B]Qué falló:[/B] la revisión no encontró problemas.');
  }

  if (d.mejoras === null) {
    l.push('[B]Qué cambiar:[/B] hoy no salieron propuestas porque el análisis falló; mañana se intenta de nuevo.');
  } else if (!d.mejoras.length) {
    l.push('[B]Qué cambiar:[/B] nada nuevo; el día no mostró una fuga clara.');
  } else {
    l.push('[B]Qué cambiar:[/B]');
    d.mejoras.forEach((m, i) =>
      l.push(
        `${i + 1}. [B]${DONDE[m.donde] ?? DONDE.bot}:[/B] ${m.mejora}` +
          (m.evidencia ? ` (${enlazarChats(m.evidencia, dominio)})` : '') +
          (m.repetida ? ' · ya se propuso antes y sigue pendiente' : ''),
      ),
    );
  }

  const sinTomar = d.sinTrabajar.filter((a) => a.pendientes > 0);
  if (sinTomar.length) {
    const total = sinTomar.reduce((n, a) => n + a.pendientes, 0);
    const detalle = sinTomar
      .slice(0, 3)
      .map((a) => `${a.nombre} (${a.pendientes})`)
      .join(', ');
    l.push(`[B]${total} derivados de los últimos 7 días siguen sin trabajar:[/B] ${detalle}${sinTomar.length > 3 ? ', y otros' : ''}.`);
  }

  return l.join('\n');
}

/** Primero lo grave y el interés perdido: son los casos que explican por qué no se matriculó alguien. */
function peso(c: CasoRevisado): number {
  if (c.hallazgos.some((h) => h.gravedad === 'alta' || h.tipo === 'interes_perdido')) return 0;
  if (c.hallazgos.length) return 1;
  return c.turnos <= 1 ? 2 : 3;
}

/** Las conversaciones que lee el análisis: hasta 4 donde se perdió a alguien, 2 con otros problemas y
 *  2 que no pasaron del primer intercambio, que es donde se va la mitad de la gente. */
export function elegirConversaciones(casos: CasoRevisado[]): CasoRevisado[] {
  const de = (p: number, n: number) => casos.filter((c) => peso(c) === p).slice(0, n);
  return [...de(0, 4), ...de(1, 2), ...de(2, 2)];
}

type Material = {
  cur: EmbudoCierre;
  semana: EmbudoCierre;
  revision: ResumenRevision;
  unIntercambio: number;
  sinTrabajar: number;
  previas: Array<{ ts: string; mejoras: any[] }>;
};

function armarMaterial(m: Material): string {
  const embudo = (e: EmbudoCierre) =>
    `${e.atendidas} conversaciones; datos capturados en ${e.captura}; derivadas a un asesor ${e.escal}; ` +
    (marca.matriculaEnChat ? `ficha de matrícula iniciada en ${e.matriculaInicia}; enlace de pago en ${e.enlacePago}; ` : '') +
    `interés perdido ${e.interesPerdido}.`;
  const p: string[] = [
    `Embudo de las últimas 24 horas: ${embudo(m.cur)}`,
    `Semana previa (7 días): ${embudo(m.semana)}`,
    `De ${m.revision.revisadas} conversaciones revisadas, ${m.unIntercambio} quedaron en un solo intercambio.`,
  ];
  if (m.sinTrabajar) p.push(`Casos derivados en los últimos 7 días que ningún asesor trabajó: ${m.sinTrabajar}.`);

  const hallazgos = m.revision.casos.flatMap((c) => c.hallazgos.map((h) => `- [${h.tipo}, ${h.gravedad}] ${c.dialogId}: ${h.detalle}`));
  p.push('', 'Problemas que marcó la revisión automática:', hallazgos.length ? hallazgos.join('\n') : '(ninguno)');

  const previas = m.previas.flatMap((x) =>
    x.mejoras.map((y: any) => `- (${new Date(x.ts).toISOString().slice(0, 10)}) ${String(y?.mejora ?? '')}`),
  );
  p.push('', 'Mejoras propuestas los días anteriores:', previas.length ? previas.join('\n') : '(ninguna)');

  p.push('', 'Conversaciones:');
  for (const c of elegirConversaciones(m.revision.casos)) {
    const t = c.texto.length > LARGO_POR_CONVERSACION ? `…${c.texto.slice(-LARGO_POR_CONVERSACION)}` : c.texto;
    p.push(`=== ${c.dialogId} ===`, t);
  }
  return p.join('\n');
}

/** Pide al modelo hasta tres mejoras. null si falló: el mensaje lo dice en vez de callarlo. */
export async function proponerMejoras(m: Material): Promise<Mejora[] | null> {
  try {
    const resp = await anthropic.messages.create({
      model: REASONER,
      max_tokens: 1200,
      system: ANALISTA,
      messages: [{ role: 'user', content: `${armarMaterial(m)}\n\nDevuelve el JSON.` }],
    });
    recordTokens((resp as any).usage);
    const raw = (resp.content as any[]).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    const lista = Array.isArray(json?.mejoras) ? json.mejoras : [];
    return lista
      .filter((x: any) => String(x?.mejora ?? '').trim())
      .slice(0, 3)
      .map((x: any) => ({
        mejora: recortar(String(x.mejora).trim(), 350),
        evidencia: recortar(String(x?.evidencia ?? '').trim(), 200, ''),
        donde: String(x?.donde) in DONDE ? String(x.donde) : 'bot',
        repetida: x?.repetida === true,
      }));
  } catch (e) {
    log.warn('control diario: el análisis falló', { err: String(e) });
    return null;
  }
}

/** Junta el día, lo analiza y lo manda a quien corresponda. Corre al terminar la revisión diaria. */
export async function enviarControlDiario(revision: ResumenRevision): Promise<string | null> {
  const destinatarios = config.controlDiarioDestinatarios;
  if (!destinatarios.length) return null;
  const st = await getState();
  if (!st.auth) return null;

  const [cur, semana, previas, asesores] = await Promise.all([
    dbEmbudoCierre(1, 0),
    dbEmbudoCierre(7, 1),
    dbMejorasPrevias(3),
    vistaPorAsesor(st.auth, '7d').catch(() => ({ filas: [], porMotivo: {}, casos: [] })),
  ]);
  const sinTrabajar = asesores.filas.map((a) => ({ nombre: a.nombre, pendientes: a.pendientes }));
  const unIntercambio = revision.casos.filter((c) => c.turnos <= 1).length;

  // Sin conversaciones no hay nada que analizar: no se gasta la llamada al modelo.
  const mejoras =
    cur.atendidas || revision.revisadas
      ? await proponerMejoras({ cur, semana, revision, unIntercambio, previas, sinTrabajar: sinTrabajar.reduce((n, a) => n + a.pendientes, 0) })
      : [];

  const ejemplos = revision.casos
    .flatMap((c) => c.hallazgos.map((h) => ({ ...h, dialogId: c.dialogId, crmEntity: c.crmEntity })))
    .sort((a, b) => Number(b.gravedad === 'alta') - Number(a.gravedad === 'alta') || Number(b.tipo === 'interes_perdido') - Number(a.tipo === 'interes_perdido'))
    .slice(0, MAX_EJEMPLOS)
    .map((h) => ({ tipo: h.tipo, detalle: recortar(h.detalle, 200), dialogId: h.dialogId, crmEntity: h.crmEntity }));

  const texto = redactarControl(
    {
      fecha: fechaEnChile(new Date()),
      cur,
      semana,
      revisadas: revision.revisadas,
      unIntercambio,
      porTipo: revision.porTipo,
      graves: revision.graves,
      ejemplos,
      mejoras,
      sinTrabajar,
    },
    st.auth.domain,
  );

  for (const userId of destinatarios) {
    await callBitrix('im.notify.personal.add', { USER_ID: userId, MESSAGE: texto }, st.auth).catch((e) =>
      log.warn('control diario: no se pudo notificar', { err: String(e), userId }),
    );
  }
  // Las mejoras quedan en la auditoría: mañana se le pasan al análisis para que marque lo que se repite.
  await audit({ type: 'control_diario', detail: { destinatarios, mejoras: mejoras ?? [], fallo: mejoras === null } });
  log.info('control diario enviado', { destinatarios, mejoras: mejoras?.length ?? null });
  return texto;
}
