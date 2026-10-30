import { runConversation, aplicarGuardian, reemplazarUltimaRespuesta } from './agentLoop';
import { brochureComoEnlace, RESULTADO_ESCALADO_COMO_ASESOR } from './toolRunner';
import { detectarIdioma, bloqueIdioma } from './idioma';
import { WHATSAPP_PROFILE } from '../core/channel';
import { consultarProgramas, detallePrograma } from '../core/catalogTool';
import { buscarCondiciones } from '../core/condicionesComerciales';
import { conAvisoDeVigencia } from '../core/vigencia';
import { preguntaPorCostosAdicionales } from '../core/guardRespuesta';
import { obtenerBrochure } from '../core/brochures';
import { consultarInformacionInstitucional, INSTRUCCION_SIN_DATO } from '../core/conocimientoComercial';
import { enlaceDePago } from '../core/mediosPago';
import { marca } from '../marca';

/**
 * Chat simulado del panel de configuración: conversar con el bot antes de publicar un cambio.
 *
 * Usa el mismo motor que la conversación real (runConversation), el mismo perfil de canal que el Live
 * Chat de Carver (Open Lines → WHATSAPP_PROFILE), el mismo bloque de idioma y el mismo guardián del
 * texto final. Lo que cambia es QUÉ PASA AFUERA:
 * - Las herramientas que solo leen (programas, precios, brochure, conocimiento, enlaces de pago) se
 *   ejecutan de verdad, así que la prueba ve los datos —y los borradores— que vería el bot.
 * - Las que escriben (registrar en el CRM, derivar, consultar la ficha del estudiante) NO se ejecutan:
 *   se responde lo que respondería la real y se le muestra a quien prueba lo que habría pasado.
 * - Nada queda en la auditoría: las métricas de conversaciones siguen contando solo las reales.
 *
 * El horario de asesores no aplica: esa puerta está en el adaptador de Open Lines, no en el motor.
 */

export type HerramientaUsada = { nombre: string; descripcion: string; simulada: boolean };

const SOLO_LECTURA = new Set([
  'consultar_programas',
  'detalle_programa',
  'consultar_condiciones_comerciales',
  'obtener_brochure',
  'consultar_informacion_institucional',
  'obtener_enlace_de_pago',
]);

// Los campos de registrar_interes_crm, como los nombra una persona.
const CAMPOS_CRM: Record<string, string> = {
  nombre: 'nombre',
  apellido: 'apellido',
  email: 'correo',
  telefono: 'teléfono',
  programa_interes: 'programa',
  profesion: 'profesión',
  direccion: 'dirección',
  comentario: 'comentario',
};

const TEMAS: Record<string, string> = {
  calendario_ingresos: 'Calendario de ingresos',
  argumentos_venta: 'Argumentos de venta',
  proceso_admision: 'Proceso de admisión',
  medios_de_pago: 'Medios de pago',
  reconocimiento_titulo: 'Reconocimiento del título',
  datos_operativos: 'Datos operativos',
  prueba_social: 'Testimonios',
};

async function ejecutar(nombre: string, input: any, mensajeCliente: string): Promise<any> {
  const catalogo = WHATSAPP_PROFILE.catalog;
  switch (nombre) {
    case 'consultar_programas':
      return consultarProgramas(input, catalogo.consultar);
    case 'detalle_programa':
      return detallePrograma(input, catalogo.detalle);
    case 'consultar_condiciones_comerciales':
      return conAvisoDeVigencia(
        buscarCondiciones(input?.programa, input?.sede, { incluirCostosAdicionales: preguntaPorCostosAdicionales(mensajeCliente) }) as Record<string, any>,
      );
    case 'obtener_brochure':
      // En la prueba no hay a quién mandarle el PDF por WhatsApp: se entrega como enlace, que es lo que
      // pasa en el Live Chat.
      return brochureComoEnlace(await obtenerBrochure({ programa: input?.programa }));
    case 'consultar_informacion_institucional': {
      const r = consultarInformacionInstitucional(String(input?.tema ?? ''));
      return r.ok ? r : { ...r, instruccion: INSTRUCCION_SIN_DATO };
    }
    case 'obtener_enlace_de_pago':
      return enlaceDePago(String(input?.programa ?? ''), String(input?.concepto ?? '') as any);
    case 'registrar_interes_crm':
      return { ok: true, actualizado: Object.keys(input ?? {}).filter((k) => input[k]) };
    case 'escalar_a_humano':
      return marca.sePresentaComoAsesor
        ? { ...RESULTADO_ESCALADO_COMO_ASESOR }
        : { ok: true, escalado: true, asesor: null, mensaje: 'Conversación derivada a un asesor. Informa al cliente que un asesor lo contactará a la brevedad.' };
    case 'consultar_estado_estudiante':
      return {
        ok: true,
        matriculado: false,
        nota: 'No figura como estudiante matriculado en el CRM. No lo contradigas: si insiste en que es estudiante, indícale el canal oficial y ofrece derivar.',
      };
    default:
      return { ok: false, error: 'NO_DISPONIBLE_EN_PRUEBA', mensaje: 'Esta acción no se puede probar acá; sigue la conversación con normalidad.' };
  }
}

/** Qué hizo el bot con cada herramienta, dicho para quien prueba (no para el modelo). */
function describir(nombre: string, input: any, r: any): string {
  switch (nombre) {
    case 'consultar_programas':
      return `Buscó programas${input?.texto ? ` sobre «${input.texto}»` : ''}: ${r?.total ?? 0} resultado${r?.total === 1 ? '' : 's'}.`;
    case 'detalle_programa':
      return r?.ok === false ? `Pidió el detalle de «${input?.nombre ?? ''}», sin resultado.` : `Leyó el detalle de ${r?.detalle?.nombre ?? r?.nombre ?? input?.nombre}.`;
    case 'consultar_condiciones_comerciales':
      return r?.encontrado ? `Consultó el precio de ${r.programa ?? input?.programa}.` : `Consultó el precio de «${input?.programa ?? ''}», sin encontrarlo.`;
    case 'obtener_brochure':
      return r?.ok ? `Entregaría el brochure de ${r.programa} (enlace verificado).` : `Pidió el brochure de ${input?.programa ?? 'un programa'}: no se pudo entregar (${r?.motivo}).`;
    case 'consultar_informacion_institucional':
      return `Consultó «${TEMAS[input?.tema] ?? input?.tema}»${r?.disponible === false ? `: no disponible (${r.motivo})` : ''}.`;
    case 'obtener_enlace_de_pago':
      return r?.ok
        ? `Pidió el enlace de pago de ${r.programa} (${input?.concepto}): ${r.medio === 'paypal' ? 'PayPal' : 'Flywire'} por USD ${r.montoUsd}.`
        : `Pidió un enlace de pago, sin resultado (${r?.motivo}).`;
    case 'registrar_interes_crm': {
      const datos = Object.entries(input ?? {})
        .filter(([, v]) => v)
        .map(([k, v]) => `${CAMPOS_CRM[k] ?? k.replace(/_/g, ' ')}: ${v}`)
        .join(', ');
      return `Registraría en el CRM${datos ? ` — ${datos}` : ''}.`;
    }
    case 'escalar_a_humano':
      return `Derivaría el caso a una persona${input?.motivo ? ` («${input.motivo}»)` : ''}. Es interno: el cliente no se entera.`;
    case 'consultar_estado_estudiante':
      return 'Consultaría en el CRM si es estudiante (en la prueba se responde que no figura).';
    default:
      return `Usaría «${nombre}», que no se puede probar acá.`;
  }
}

/** Un turno de la conversación de prueba. `historial` son los mensajes de turnos anteriores tal como
 *  los devolvió esta misma función: así el bot recuerda lo que consultó antes, como en la real. */
export async function simularTurno(
  historial: any[],
  mensaje: string,
): Promise<{ texto: string; historial: any[]; herramientas: HerramientaUsada[] }> {
  const messages = [...historial, { role: 'user', content: mensaje }];
  const inicioTurno = messages.length;
  const herramientas: HerramientaUsada[] = [];
  const exec = async (nombre: string, input: any) => {
    const r = await ejecutar(nombre, input, mensaje);
    herramientas.push({ nombre, descripcion: describir(nombre, input, r), simulada: !SOLO_LECTURA.has(nombre) });
    return r;
  };
  const perfil = { ...WHATSAPP_PROFILE, systemPrompt: WHATSAPP_PROFILE.systemPrompt + bloqueIdioma(detectarIdioma(mensaje)) };
  const { text, messages: finales } = await runConversation({ profile: perfil, auditId: 'simulacion', simulacion: true }, messages, exec);
  const texto = marca.guardRespuesta
    ? await aplicarGuardian(text, { mensajeCliente: mensaje, history: historial, mensajesDelTurno: finales.slice(inicioTurno), simulacion: true })
    : text;
  if (texto !== text) reemplazarUltimaRespuesta(finales, texto);
  return { texto, historial: finales, herramientas };
}
