import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { callCrm } from '../bitrix/client';
import { config } from '../config';
import { getUsuarios } from './directory';
import { esAsesorValido } from './equipo';
import { audit } from '../obs/audit';
import { once, kvDel } from '../store/kv';
import { log } from '../log';
import type { Auth } from '../store';
import type { CrmEntities } from './entities';
import type { BitrixTaskAddResult } from '../bitrix/types';

/**
 * Estudiantes MATRICULADOS que escriben con un inconveniente (hallazgo 10 de la auditoría de Carver).
 *
 * Antes, un estudiante que escribía "no puedo entrar a la plataforma" recibía el flujo de venta: le
 * ofrecían programas, le pedían datos de contacto y lo derivaban al punto de entrada comercial, que
 * no es quien lo acompaña. Cada estudiante de Carver tiene una Advisor: es la responsable de su
 * negociación en el embudo "Advisor Carver" (107).
 *
 * Solo se consulta la ficha del PROPIO contacto del chat —nunca la de un tercero—, y el correo de la
 * Advisor se entrega únicamente si se puede verificar: persona activa, del equipo de la marca, y con
 * correo del dominio institucional. Si no, se entrega el canal oficial general y se deriva.
 */

export type AdvisorVerificado = { id: number; nombre: string; email: string; telefono?: string };

/**
 * Tabla de respaldo: qué Advisor acompaña cada tipo de programa.
 *
 * Hace falta porque en el embudo 107 el responsable casi nunca es una persona: de 1.030
 * negociaciones, 968 tienen Advisor y el resto quedó con el robot "Resp. Autom." (#45), que no es
 * alguien a quien escribirle. Sin este respaldo, un estudiante de esos recibía "no pude verificar
 * quién te acompaña" — que es cierto pero inútil.
 *
 * El orden importa: primero se intenta la Advisor REAL de su negociación; la tabla solo entra
 * cuando esa no existe o no es válida. Y lo que la tabla entrega igual se verifica contra Bitrix.
 */
type AdvisorDePrograma = { userId: number; nombre: string; email: string; tipos: string[] };

const TABLA_ADVISORS: { advisors: AdvisorDePrograma[]; telefono?: string } = (() => {
  try {
    const ruta = fileURLToPath(new URL('../../data/carver/advisors.json', import.meta.url));
    const j = JSON.parse(readFileSync(ruta, 'utf8')) as { advisors?: AdvisorDePrograma[]; telefonoAdvisors?: string };
    return { advisors: Array.isArray(j.advisors) ? j.advisors : [], telefono: j.telefonoAdvisors };
  } catch {
    return { advisors: [] };
  }
})();

const ADVISORS_POR_PROGRAMA = TABLA_ADVISORS.advisors;

/** Sin tildes y en minúsculas: "Maestría en Psicología" y "maestria en psicologia" son lo mismo. */
const normalizar = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** La Advisor que cubre este programa, o null. Un programa sin cobertura (cursos de educación
 *  continua, diplomados) devuelve null a propósito: es preferible derivar al canal oficial que
 *  mandarle el estudiante a alguien que no lo acompaña. */
export function advisorDelPrograma(programa: string | null): AdvisorDePrograma | null {
  if (!programa) return null;
  const p = normalizar(programa);
  return ADVISORS_POR_PROGRAMA.find((a) => a.tipos.some((t) => p.includes(normalizar(t)))) ?? null;
}

/**
 * El teléfono por el que se escribe a las Advisor: uno solo, institucional, el mismo para todas.
 *
 * NO sale de la ficha de Bitrix. Ahí algunas tienen cargado su móvil personal, que es un dato del
 * empleado y no un canal de atención: entregarlo a un estudiante es repartir el celular de alguien
 * que no dio permiso. Se entrega solo en formato internacional, porque un número a medias es peor
 * que ninguno — el estudiante lo marca, no entra, y concluye que nadie lo atiende.
 */
const telefonoDeLasAdvisors = (() => {
  const limpio = String(TABLA_ADVISORS.telefono ?? '').replace(/[\s()-]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(limpio) ? limpio : undefined;
})();
export type EstadoEstudiante =
  | { ok: true; matriculado: false; motivo?: string }
  | {
      ok: true;
      matriculado: true;
      programa: string | null;
      dealId: number | null;
      advisor: (AdvisorVerificado & { verificado: true }) | null;
      motivoSinAdvisor?: string;
    }
  | { ok: false; error: string };

type DealResumen = { ID: string; CATEGORY_ID: string; STAGE_ID: string; ASSIGNED_BY_ID: string; [k: string]: any };

/** Contacto al que pertenece el chat (directo, o a través de su negociación). */
async function contactoDelChat(entities: CrmEntities, auth: Auth): Promise<number | null> {
  if (entities.contact) return entities.contact;
  if (entities.deal) {
    const d: any = await callCrm('crm.deal.get', { id: entities.deal, select: ['CONTACT_ID'] }, auth);
    const c = Number(d?.CONTACT_ID ?? 0);
    return c > 0 ? c : null;
  }
  return null;
}

export async function consultarEstadoEstudiante(entities: CrmEntities, auth: Auth): Promise<EstadoEstudiante> {
  if (!config.estudiantesCategorias.length && !config.etapasMatriculado.length) {
    return { ok: true, matriculado: false, motivo: 'sin_configuracion' };
  }
  try {
    const contactId = await contactoDelChat(entities, auth);
    // Sin contacto no hay forma de verificar quién es: no se presume matrícula por lo que diga el chat.
    if (!contactId) return { ok: true, matriculado: false, motivo: 'sin_contacto_para_verificar' };

    const categoriasComerciales = config.etapasMatriculado
      .map((s) => /^C(\d+):/.exec(s)?.[1])
      .filter((x): x is string => !!x)
      .map(Number);
    const categorias = [...new Set([...config.estudiantesCategorias, ...categoriasComerciales])];
    const select = ['ID', 'CATEGORY_ID', 'STAGE_ID', 'ASSIGNED_BY_ID', 'DATE_CREATE'];
    if (config.ufPrograma) select.push(config.ufPrograma);
    const r = await callCrm<DealResumen[]>(
      'crm.deal.list',
      { filter: { CONTACT_ID: contactId, '@CATEGORY_ID': categorias }, select, order: { DATE_CREATE: 'DESC' } },
      auth,
    );
    const deals = Array.isArray(r) ? r : [];

    // Negociación de acompañamiento (Advisor): cualquier etapa salvo "retirado/perdido".
    const deEstudiante = deals.find(
      (d) => config.estudiantesCategorias.includes(Number(d.CATEGORY_ID)) && !/:(LOSE|APOLOGY)$/.test(String(d.STAGE_ID)),
    );
    const ganada = deals.find((d) => config.etapasMatriculado.includes(String(d.STAGE_ID)));
    if (!deEstudiante && !ganada) return { ok: true, matriculado: false };

    const ref = deEstudiante ?? ganada!;
    const programa = config.ufPrograma ? (String(ref[config.ufPrograma] ?? '').trim() || null) : null;
    if (!deEstudiante) {
      return { ok: true, matriculado: true, programa, dealId: Number(ref.ID), advisor: null, motivoSinAdvisor: 'sin_negociacion_de_acompanamiento' };
    }

    const advisor = await resolverAdvisor(Number(deEstudiante.ASSIGNED_BY_ID), programa, auth);
    return {
      ok: true,
      matriculado: true,
      programa,
      dealId: Number(deEstudiante.ID),
      advisor: advisor.ok ? { ...advisor.advisor, verificado: true } : null,
      ...(advisor.ok ? {} : { motivoSinAdvisor: advisor.motivo }),
    };
  } catch (e) {
    log.warn('consultarEstadoEstudiante falló', { err: String(e) });
    return { ok: false, error: 'CRM_NO_DISPONIBLE' };
  }
}

/**
 * Quién acompaña a este estudiante: la responsable de su negociación si es una Advisor válida y,
 * si no, la que cubre su tipo de programa. Nunca se devuelve a alguien sin verificar en Bitrix.
 */
async function resolverAdvisor(
  responsableId: number,
  programa: string | null,
  auth: Auth,
): Promise<{ ok: true; advisor: AdvisorVerificado } | { ok: false; motivo: string }> {
  const directa = await advisorVerificado(responsableId, auth);
  if (directa.ok) return directa;

  const deTabla = advisorDelPrograma(programa);
  if (!deTabla) return { ok: false, motivo: programa ? 'programa_sin_advisor' : directa.motivo };

  // La tabla dice quién; Bitrix dice si sigue activa y en el equipo. Si alguien se va de Carver, su
  // nombre deja de entregarse sin tener que acordarse de editar el archivo.
  const verificada = await advisorVerificado(deTabla.userId, auth);
  if (!verificada.ok) return { ok: false, motivo: `advisor_de_tabla_${verificada.motivo}` };
  return { ok: true, advisor: verificada.advisor };
}

async function advisorVerificado(
  userId: number,
  auth: Auth,
): Promise<{ ok: true; advisor: AdvisorVerificado } | { ok: false; motivo: string }> {
  if (!userId) return { ok: false, motivo: 'sin_responsable' };
  const [u] = await getUsuarios([userId], auth);
  if (!u || u.nombre.startsWith('Usuario ')) return { ok: false, motivo: 'usuario_no_resuelto' };
  // El responsable "Resp. Autom." (robot) tiene a cargo los estudiantes nuevos hasta que se asigna
  // una Advisor: no es una persona a la que escribirle.
  if (!esAsesorValido(u)) return { ok: false, motivo: 'responsable_no_valido' };
  const email = String(u.email ?? '').trim().toLowerCase();
  if (!config.dominioCorreoOficial || !email.endsWith(`@${config.dominioCorreoOficial}`)) {
    return { ok: false, motivo: 'correo_no_institucional' };
  }
  // El telefono NO sale de u.telefono (PERSONAL_MOBILE): ese es el movil personal de la persona.
  return { ok: true, advisor: { id: u.id, nombre: u.nombre, email, telefono: telefonoDeLasAdvisors } };
}

/** Tarea para la Advisor sobre la negociación de acompañamiento. Una por día y estudiante: si
 *  escribe tres veces por el mismo problema, la Advisor no recibe tres tareas. NO reasigna nada. */
export async function crearTareaAdvisor(
  dealId: number,
  advisorId: number,
  motivo: string,
  auth: Auth,
): Promise<boolean> {
  const candado = `tarea:estudiante:${dealId}:${advisorId}`;
  if (!(await once(candado, 24 * 3600))) return false;
  try {
    const t = await callCrm<BitrixTaskAddResult>(
      'tasks.task.add',
      {
        fields: {
          TITLE: `🎓 Estudiante pide ayuda — Deal #${dealId}`,
          DESCRIPTION:
            'Un estudiante de tu seguimiento escribió por WhatsApp con un inconveniente y el asistente le indicó ' +
            `que tú lo acompañas.\n\nMotivo: ${motivo || 'no especificado'}\n\nRevisa la conversación en la negociación.`,
          RESPONSIBLE_ID: advisorId,
          DEADLINE: new Date(Date.now() + config.asignacionTareaHoras * 3600_000).toISOString(),
          PRIORITY: 2,
          UF_CRM_TASK: [`D_${dealId}`],
        },
      },
      auth,
    );
    await audit({ type: 'derivacion', crmEntity: `deal#${dealId}`, detail: { decision: 'tarea_a_advisor_estudiante', asesor: advisorId } });
    log.info('tarea para la Advisor creada', { dealId, advisorId, taskId: (t as any)?.task?.id ?? (t as any)?.id });
    return true;
  } catch (e) {
    log.warn('no se pudo crear la tarea para la Advisor', { err: String(e), dealId, advisorId });
    // Sin tarea no hay aviso: se libera el candado para que el próximo mensaje lo reintente.
    await kvDel(candado).catch(() => {});
    return false;
  }
}
