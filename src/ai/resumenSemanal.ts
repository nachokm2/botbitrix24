import { callBitrix } from '../bitrix/client';
import { dbMetricsSummary, dbHallazgosRecientes, dbEmbudoCierre, type EmbudoCierre } from '../store/db';
import { vistaPorAsesor } from '../crm/vistaAsesores';
import { getState } from '../store';
import { once } from '../store/kv';
import { config } from '../config';
import { marca } from '../marca';
import { audit } from '../obs/audit';
import { horaEnChile } from './seguimiento';
import { log } from '../log';

/**
 * Resumen semanal, empujado a Bitrix.
 *
 * El panel existe y está completo, pero hay que acordarse de abrirlo. Durante el piloto, los números
 * que movieron decisiones fueron siempre los que alguien pidió expresamente. Esto los manda solo,
 * una vez por semana, al lugar donde la gente ya está mirando.
 *
 * Es deliberadamente corto: cinco líneas y el dato accionable. Un informe largo no se lee.
 */

const DIA_SEMANA_TZ = 'America/Santiago';

/** Día de la semana en Chile (0 = domingo), sin depender de la zona horaria del servidor. */
export function diaEnChile(fecha: Date): number {
  const nombre = new Intl.DateTimeFormat('en-US', { timeZone: DIA_SEMANA_TZ, weekday: 'short' }).format(fecha);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(nombre);
}

const pct = (parte: number, total: number) => (total > 0 ? Math.round((parte / total) * 100) : 0);

// Tendencia semana contra semana, en texto corto para la notificación de Bitrix.
const ppDelta = (curP: number, curT: number, prevP: number, prevT: number): string => {
  const delta = pct(curP, curT) - pct(prevP, prevT);
  return delta === 0 ? 'igual' : `${delta > 0 ? '+' : ''}${delta} pp`;
};
const nDelta = (cur: number, prev: number): string => {
  const delta = cur - prev;
  return delta === 0 ? 'igual' : `${delta > 0 ? '+' : ''}${delta}`;
};

export type DatosResumen = {
  conversaciones: number;
  capturaConvs: number;
  escalConvs: number;
  errores: number;
  pendientesPorAsesor: Array<{ nombre: string; pendientes: number }>;
  hallazgosGraves: number;
  topProgramas: Array<{ k: string; c: number }>;
  // Revisión de cierre: el embudo de esta semana y el de la previa, para mostrar la tendencia.
  cierre?: { cur: EmbudoCierre; prev: EmbudoCierre };
};

/** Arma el texto del mensaje. Pura, para poder revisar la redacción sin tocar Bitrix. */
export function redactarResumen(d: DatosResumen): string {
  const l: string[] = [`[B]Resumen semanal — agente ${marca.etiquetaPanel}[/B]`];

  if (!d.conversaciones) {
    l.push('Esta semana el bot no atendió conversaciones.');
    return l.join('\n');
  }

  l.push(
    `${d.conversaciones} conversaciones atendidas. ` +
      `Datos capturados en ${d.capturaConvs} (${pct(d.capturaConvs, d.conversaciones)}%), ` +
      `derivadas a un asesor ${d.escalConvs} (${pct(d.escalConvs, d.conversaciones)}%).`,
  );

  // Revisión de cierre: lo que importa para subir las matrículas es si la captura y la derivación
  // mejoran semana a semana, y si el interés perdido baja. Por eso va con la tendencia al lado.
  if (d.cierre) {
    const { cur, prev } = d.cierre;
    l.push(
      `[B]Cierre vs. semana previa:[/B] ` +
        `captura ${pct(cur.captura, cur.atendidas)}% (${ppDelta(cur.captura, cur.atendidas, prev.captura, prev.atendidas)}), ` +
        `derivación ${pct(cur.escal, cur.atendidas)}% (${ppDelta(cur.escal, cur.atendidas, prev.escal, prev.atendidas)}).`,
    );
    l.push(
      `Interés perdido (interesado que se fue sin captura ni derivación): ` +
        `${cur.interesPerdido} (${nDelta(cur.interesPerdido, prev.interesPerdido)}).`,
    );
    if (marca.matriculaEnChat) {
      l.push(
        `Matrícula en el chat: ${cur.matriculaInicia} iniciaron la ficha, ` +
          `${cur.enlacePago} con enlace de pago entregado.`,
      );
    }
  }

  const sinTomar = d.pendientesPorAsesor.filter((a) => a.pendientes > 0);
  if (sinTomar.length) {
    const total = sinTomar.reduce((n, a) => n + a.pendientes, 0);
    const detalle = sinTomar
      .slice(0, 3)
      .map((a) => `${a.nombre} (${a.pendientes})`)
      .join(', ');
    // Va arriba y con nombre porque es lo único de este resumen sobre lo que se puede actuar hoy.
    l.push(`[B]${total} casos derivados siguen sin trabajar[/B]: ${detalle}${sinTomar.length > 3 ? ', y otros' : ''}.`);
  } else {
    l.push('Todos los casos derivados fueron trabajados.');
  }

  if (d.topProgramas.length) {
    l.push(`Más consultado: ${d.topProgramas.slice(0, 3).map((p) => `${p.k} (${p.c})`).join(', ')}.`);
  }

  const cola: string[] = [];
  if (d.errores) cola.push(`${d.errores} fallas técnicas`);
  if (d.hallazgosGraves) cola.push(`${d.hallazgosGraves} hallazgos graves de la revisión`);
  if (cola.length) l.push(`Para mirar: ${cola.join(' y ')} — el detalle está en el panel.`);

  return l.join('\n');
}

/** Junta los datos de la semana y manda el resumen a quien corresponda. */
export async function enviarResumenSemanal(): Promise<string | null> {
  const destinatarios = config.resumenSemanalDestinatarios;
  if (!destinatarios.length) return null;
  const st = await getState();
  if (!st.auth) return null;

  const [agg, hallazgos, asesores, cierreCur, cierrePrev] = await Promise.all([
    dbMetricsSummary('7d'),
    dbHallazgosRecientes(100),
    vistaPorAsesor(st.auth, '7d').catch(() => ({ filas: [], porMotivo: {}, casos: [] })),
    dbEmbudoCierre(7, 0),
    dbEmbudoCierre(7, 7),
  ]);
  if (!agg) return null;

  const texto = redactarResumen({
    conversaciones: agg.conversaciones ?? 0,
    capturaConvs: agg.capturaConvs ?? 0,
    escalConvs: agg.escalConvs ?? 0,
    errores: agg.errores ?? 0,
    pendientesPorAsesor: asesores.filas.map((a) => ({ nombre: a.nombre, pendientes: a.pendientes })),
    hallazgosGraves: hallazgos.filter((h: any) => h.gravedad === 'alta').length,
    topProgramas: agg.topProgramas ?? [],
    cierre: { cur: cierreCur, prev: cierrePrev },
  });

  for (const userId of destinatarios) {
    await callBitrix('im.notify.personal.add', { USER_ID: userId, MESSAGE: texto }, st.auth).catch((e) =>
      log.warn('resumen semanal: no se pudo notificar', { err: String(e), userId }),
    );
  }
  await audit({ type: 'resumen_semanal', detail: { destinatarios, largo: texto.length } });
  log.info('resumen semanal enviado', { destinatarios });
  return texto;
}

let intervalo: ReturnType<typeof setInterval> | null = null;
const CHEQUEO_MIN = 15;

/** Lo manda una vez por semana, el día y la hora configurados (hora de Chile). */
export function iniciarResumenSemanal(): void {
  if (!config.resumenSemanalDestinatarios.length || intervalo) return;
  const tick = async () => {
    try {
      const ahora = new Date();
      if (diaEnChile(ahora) !== config.resumenSemanalDia) return;
      if (horaEnChile(ahora) !== config.resumenSemanalHora) return;
      // Una marca por semana en Redis: con dos réplicas o un reinicio dentro de la misma hora, el
      // resumen saldría dos veces.
      if (!(await once(`resumen:${ahora.toISOString().slice(0, 10)}`, 48 * 3600))) return;
      await enviarResumenSemanal();
    } catch (e) {
      log.warn('resumen semanal falló', { err: String(e) });
    }
  };
  intervalo = setInterval(() => void tick(), CHEQUEO_MIN * 60_000);
  intervalo.unref();
  log.info('resumen semanal activo', {
    dia: config.resumenSemanalDia,
    hora: config.resumenSemanalHora,
    destinatarios: config.resumenSemanalDestinatarios.length,
  });
}
