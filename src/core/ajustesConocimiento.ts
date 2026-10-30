import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { marca } from '../marca';
import { motivoEnlaceInvalido } from './ajustesProgramas';
// Solo tipos: en ejecución este módulo no depende de ajustes.ts ni de conocimientoComercial.ts, que son
// los que lo usan a él.
import type { ErrorCampo, Validacion } from './ajustes';
import type { BaseConocimiento } from './conocimientoComercial';

/**
 * Sección "Conocimiento institucional" del panel de configuración (ver core/ajustes.ts): lo que el bot
 * responde con la herramienta consultar_informacion_institucional —fechas de ingreso, argumentos de
 * venta, proceso de admisión, reconocimiento del título por país, datos operativos y testimonios—.
 *
 * Cada tema conserva las reglas de siempre (core/conocimientoComercial.ts): el bot solo lo usa si está
 * validado, tiene fuente y no venció. El panel edita el contenido y esos tres datos; la regla no cambia.
 *
 * Medios de pago queda fuera a propósito: ahí hay enlaces de pago, y se editarán junto con los enlaces
 * de PayPal, con sus propias reglas.
 */

export type TipoCampo = 'texto' | 'largo' | 'fecha' | 'url';
export type CampoEsquema = { clave: string; etiqueta: string; tipo: TipoCampo; obligatorio: boolean; max: number; ayuda?: string };
export type TemaEsquema = {
  tema: string;
  titulo: string;
  ayuda: string;
  campos: CampoEsquema[];
  /** Campo que se numera solo según el orden (los pasos de admisión). */
  numerado?: string;
};

/** Qué se edita de cada tema y cómo lo ve quien no programa. El orden es el del menú del panel. */
export const ESQUEMA_CONOCIMIENTO: TemaEsquema[] = [
  {
    tema: 'calendario_ingresos',
    titulo: 'Calendario de ingresos',
    ayuda: 'Un ciclo por fila. El bot solo ofrece los ciclos cuyo inicio de clases todavía no pasó, así que los antiguos pueden quedar.',
    campos: [
      { clave: 'ciclo', etiqueta: 'Ciclo', tipo: 'texto', obligatorio: true, max: 20, ayuda: 'Ej.: C05TEP26' },
      { clave: 'programa', etiqueta: 'Programa', tipo: 'texto', obligatorio: true, max: 120, ayuda: '«todos», o el nombre de un programa si el ciclo es solo para él.' },
      { clave: 'inicioClases', etiqueta: 'Inicio de clases', tipo: 'fecha', obligatorio: true, max: 10 },
      { clave: 'cierrePostulacion', etiqueta: 'Cierre de postulación', tipo: 'fecha', obligatorio: true, max: 10 },
    ],
  },
  {
    tema: 'argumentos_venta',
    titulo: 'Argumentos de venta',
    ayuda: 'Lo que distingue a la universidad. El bot los usa cuando preguntan qué incluye el programa o por qué elegir Carver, respetando las condiciones escritas en cada uno.',
    campos: [
      { clave: 'argumento', etiqueta: 'Argumento', tipo: 'texto', obligatorio: true, max: 120 },
      { clave: 'detalle', etiqueta: 'Detalle', tipo: 'largo', obligatorio: true, max: 900, ayuda: 'Escribe las condiciones tal como son («sujeto a cupos», «para estudiantes regulares»): el bot no las agrega por su cuenta.' },
    ],
  },
  {
    tema: 'proceso_admision',
    titulo: 'Proceso de admisión',
    ayuda: 'Los pasos para matricularse, en orden. El número de cada paso se pone solo.',
    numerado: 'paso',
    campos: [{ clave: 'descripcion', etiqueta: 'Descripción del paso', tipo: 'largo', obligatorio: true, max: 400 }],
  },
  {
    tema: 'reconocimiento_titulo',
    titulo: 'Reconocimiento del título por país',
    ayuda: 'Una fila por país, más una «general» para todos. El bot responde por el país de la persona con lo que se puede afirmar, y nunca dice lo que está en «no afirmar».',
    campos: [
      { clave: 'pais', etiqueta: 'País', tipo: 'texto', obligatorio: true, max: 80 },
      { clave: 'puedeAfirmar', etiqueta: 'Lo que el bot SÍ puede afirmar', tipo: 'largo', obligatorio: true, max: 900 },
      { clave: 'noAfirmar', etiqueta: 'Lo que el bot NUNCA debe afirmar', tipo: 'largo', obligatorio: true, max: 600 },
      { clave: 'verificacion', etiqueta: 'Verificación (opcional)', tipo: 'largo', obligatorio: false, max: 400, ayuda: 'Un enlace oficial para verificar, con una frase que diga qué es. Sin esto, el bot nombra la entidad sin dar enlaces.' },
    ],
  },
  {
    tema: 'datos_operativos',
    titulo: 'Datos operativos',
    ayuda: 'Respuestas aprobadas sobre horario de clases, pagos, convalidación, certificados y programas en inglés.',
    campos: [
      { clave: 'tema', etiqueta: 'Tema', tipo: 'texto', obligatorio: true, max: 80 },
      { clave: 'respuesta', etiqueta: 'Respuesta aprobada', tipo: 'largo', obligatorio: true, max: 600 },
      { clave: 'instruccionInterna', etiqueta: 'Instrucción interna (opcional)', tipo: 'largo', obligatorio: false, max: 500, ayuda: 'Guía para el bot. No se le dice a la persona.' },
    ],
  },
  {
    tema: 'prueba_social',
    titulo: 'Testimonios',
    ayuda: 'Testimonios autorizados. El bot comparte el texto tal cual, con su enlace, y nunca inventa otros.',
    campos: [
      { clave: 'titulo', etiqueta: 'Título', tipo: 'texto', obligatorio: true, max: 80 },
      { clave: 'texto', etiqueta: 'Texto aprobado', tipo: 'largo', obligatorio: true, max: 500 },
      { clave: 'enlace', etiqueta: 'Enlace', tipo: 'url', obligatorio: true, max: 300 },
      { clave: 'programa', etiqueta: 'Programa', tipo: 'texto', obligatorio: false, max: 120, ayuda: '«general» o el programa al que corresponde: el bot elige el que calce con el interés de la persona.' },
    ],
  },
];

export type Entrada = Record<string, string | number>;
export type TemaAjustable = {
  /** true = el bot lo usa ("validado" en el archivo). */
  activo: boolean;
  /** AAAA-MM-DD; pasada esa fecha el bot deja de usar el tema y dice que no tiene el dato. Vacío = sin fecha. */
  vigenteHasta: string;
  fuente: string;
  responsable: string;
  entradas: Entrada[];
};
export type AjustesConocimiento = { temas: Record<string, TemaAjustable> };

const MAX_ENTRADAS = 60;

let baseCache: BaseConocimiento | null = null;

/** El archivo de siempre. Vacío donde la marca no tiene base de conocimiento (Postgrados). */
export function conocimientoBase(): BaseConocimiento {
  if (baseCache) return baseCache;
  if (!marca.baseConocimiento) return (baseCache = { temas: {} });
  try {
    baseCache = JSON.parse(readFileSync(fileURLToPath(new URL('../../data/carver/conocimiento-comercial.json', import.meta.url)), 'utf8')) as BaseConocimiento;
  } catch {
    baseCache = { temas: {} };
  }
  return baseCache;
}

export function conocimientoPorDefecto(): AjustesConocimiento {
  const temas: Record<string, TemaAjustable> = {};
  const base = conocimientoBase();
  for (const e of ESQUEMA_CONOCIMIENTO) {
    const t = base.temas?.[e.tema];
    if (!t) continue;
    temas[e.tema] = {
      activo: t.estado === 'validado',
      vigenteHasta: t.vigenteHasta ?? '',
      fuente: t.fuente ?? '',
      responsable: t.responsable ?? '',
      entradas: (t.entradas ?? []).map((x) => ({ ...(x as Entrada) })),
    };
  }
  return { temas };
}

function fechaValida(texto: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) return false;
  const d = new Date(`${texto}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === texto;
}

const objeto = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {};

// Los mensajes los lee alguien que no programa: dicen qué corregir, no qué regla se violó.
export function validarConocimiento(entrada: unknown): Validacion<AjustesConocimiento> {
  const recibidos = objeto(objeto(entrada).temas);
  const defecto = conocimientoPorDefecto().temas;
  const errores: ErrorCampo[] = [];
  const temas: Record<string, TemaAjustable> = {};

  // Se recorre el esquema y no lo recibido: un tema desconocido se ignora, y uno que falta conserva lo
  // del archivo.
  for (const e of ESQUEMA_CONOCIMIENTO) {
    if (!defecto[e.tema]) continue;
    const t = { ...defecto[e.tema], ...objeto(recibidos[e.tema]) } as Record<string, unknown>;
    const error = (campo: string, mensaje: string) => errores.push({ campo: `temas.${e.tema}.${campo}`, mensaje });

    const activo = t.activo === true;
    const vigenteHasta = String(t.vigenteHasta ?? '').trim();
    if (vigenteHasta && !fechaValida(vigenteHasta)) error('vigenteHasta', 'La fecha de vigencia no es válida.');
    const fuente = String(t.fuente ?? '').trim().slice(0, 300);
    // Sin fuente el bot no usa el tema (core/conocimientoComercial.ts): mejor decirlo acá que publicar
    // un tema "activo" que en la conversación no aparece.
    if (activo && !fuente) error('fuente', 'Indica de dónde sale esta información (el documento o el área que la aprobó). Sin fuente, el bot no la usa.');
    const responsable = String(t.responsable ?? '').trim().slice(0, 120);

    const crudas = Array.isArray(t.entradas) ? t.entradas : null;
    const entradas: Entrada[] = [];
    if (!crudas) error('entradas', 'La lista no es válida.');
    else if (crudas.length > MAX_ENTRADAS) error('entradas', `Puedes cargar hasta ${MAX_ENTRADAS} filas en este tema.`);
    else {
      crudas.forEach((cruda, i) => {
        const x = objeto(cruda);
        const fila: Entrada = {};
        if (e.numerado) fila[e.numerado] = i + 1;
        for (const c of e.campos) {
          const valor = String(x[c.clave] ?? '').trim();
          const campo = `entradas.${i}.${c.clave}`;
          if (!valor) {
            if (c.obligatorio) error(campo, `Completa «${c.etiqueta}».`);
            continue; // un opcional vacío no se guarda: "sin verificación" es que no esté
          }
          if (valor.length > c.max) error(campo, `«${c.etiqueta}» es demasiado largo (hasta ${c.max} letras).`);
          if (c.tipo === 'fecha' && !fechaValida(valor)) error(campo, `«${c.etiqueta}» no es una fecha válida.`);
          if (c.tipo === 'url') {
            const motivo = motivoEnlaceInvalido(valor);
            if (motivo) error(campo, motivo);
          }
          fila[c.clave] = valor;
        }
        entradas.push(fila);
      });
      if (!entradas.length && activo) error('entradas', 'Agrega al menos una fila, o desactiva el tema.');
    }

    if (e.tema === 'calendario_ingresos') {
      // El bot no elige entre dos fechas para el mismo ciclo: con eso, dice que no tiene el dato.
      const vistos = new Map<string, string>();
      entradas.forEach((f, i) => {
        if (f.inicioClases && f.cierrePostulacion && String(f.cierrePostulacion) > String(f.inicioClases)) {
          error(`entradas.${i}.cierrePostulacion`, 'El cierre de postulación no puede ser después del inicio de clases.');
        }
        const clave = `${String(f.ciclo).toLowerCase()}|${String(f.programa).toLowerCase()}`;
        const previa = vistos.get(clave);
        if (previa !== undefined && previa !== String(f.inicioClases)) {
          error(`entradas.${i}.inicioClases`, `El ciclo ${f.ciclo} para «${f.programa}» ya está con otra fecha de inicio. Con dos fechas, el bot no sabría cuál dar.`);
        }
        vistos.set(clave, String(f.inicioClases));
      });
    }

    temas[e.tema] = { activo, vigenteHasta, fuente, responsable, entradas };
  }
  if (errores.length) return { ok: false, errores };
  return { ok: true, valor: { temas } };
}

/** La base de conocimiento con lo publicado en el panel. Lo que el panel no edita (medios de pago,
 *  notas internas del archivo) queda tal cual. */
export function aplicarAjustesAConocimiento(base: BaseConocimiento, ajustes: AjustesConocimiento): BaseConocimiento {
  const temas = { ...(base.temas ?? {}) };
  for (const [tema, t] of Object.entries(ajustes.temas ?? {})) {
    const previo = temas[tema];
    if (!previo) continue;
    temas[tema] = {
      ...previo,
      estado: t.activo ? 'validado' : 'pendiente',
      vigenteHasta: t.vigenteHasta || null,
      fuente: t.fuente || null,
      responsable: t.responsable || null,
      entradas: t.entradas,
    };
  }
  return { ...base, temas };
}
