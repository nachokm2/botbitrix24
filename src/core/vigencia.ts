import { ajustesPrecios } from './ajustes';

/**
 * Caducidad de la información comercial.
 *
 * Los precios, las becas y el "cupos completos hasta marzo de 2027" se validaron una vez con la
 * dirección y desde entonces están congelados en el código. Cuando cambien, nadie va a acordarse de
 * avisarle al bot, y el bot va a seguir afirmándolos con total seguridad — que es la peor forma de
 * equivocarse frente a un cliente que está decidiendo dónde gastar varios miles de dólares.
 *
 * Esto no impide cotizar: pasada la fecha, agrega al resultado de la herramienta una advertencia
 * para que el bot entregue el valor como referencia y ofrezca confirmarlo. Preferible a dos
 * alternativas peores: callar un precio que probablemente siga siendo correcto, o afirmar como
 * vigente uno que lleva meses sin revisarse.
 */

export type EstadoVigencia = { vigente: boolean; diasVencida: number | null; hasta: string | null };

export function estadoVigencia(hoy = new Date()): EstadoVigencia {
  // Lo publicado en "Precios" del panel; sin nada publicado, CONDICIONES_VIGENCIA_HASTA de Railway.
  const hasta = ajustesPrecios().vigenciaHasta;
  if (!hasta || !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) return { vigente: true, diasVencida: null, hasta: null };
  // Se compara al final del día indicado: "vigente hasta el 31" incluye el 31 entero.
  const limite = new Date(`${hasta}T23:59:59Z`).getTime();
  const diff = hoy.getTime() - limite;
  if (diff <= 0) return { vigente: true, diasVencida: 0, hasta };
  return { vigente: false, diasVencida: Math.ceil(diff / 86400_000), hasta };
}

const AVISO =
  'ATENCIÓN: la planilla de precios y condiciones no se revisa desde hace tiempo y pudo cambiar. ' +
  'Entrega el valor como REFERENCIA, dilo con naturalidad ("este es el valor que tengo registrado, ' +
  'déjame confirmártelo") y ofrece confirmarlo antes de que la persona tome una decisión. NUNCA ' +
  'presentes estas cifras como definitivas ni cierres una matrícula sobre ellas.';

/** Añade la advertencia al resultado de la herramienta de condiciones, si corresponde. */
export function conAvisoDeVigencia<T extends Record<string, any>>(resultado: T, hoy = new Date()): T {
  const v = estadoVigencia(hoy);
  if (v.vigente) return resultado;
  return { ...resultado, avisoVigencia: AVISO, nota: resultado.nota ? `${AVISO} ${resultado.nota}` : AVISO };
}
