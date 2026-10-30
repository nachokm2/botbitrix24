import { anthropic, REASONER } from './client';
import { recordTokens } from '../obs/metrics';
import { dbAcumularTokens } from '../store/db';
import { ESQUEMA_CONOCIMIENTO } from '../core/ajustesConocimiento';
import { CONCEPTOS_ENLACE } from '../core/ajustesAcciones';
import { esPdf, esZip, textoDeDocx } from '../core/documentos';

/**
 * Importar un documento de admisión o finanzas al panel de configuración.
 *
 * La dirección y admisión entregan lo que el bot debe saber en documentos de Word o PDF: el calendario
 * de ingresos, el reconocimiento por país, los enlaces de pago. Hasta ahora alguien los traspasaba a
 * mano. Acá el modelo lee el documento y propone el contenido con la MISMA forma que la sección del
 * panel, y el panel lo carga en pantalla como un cambio sin guardar.
 *
 * Lo que esto NO hace es publicar: la propuesta pasa por las mismas validaciones que cualquier cambio
 * y alguien la revisa, la guarda y la publica. El modelo solo traspasa; si el documento no dice algo,
 * la propuesta no lo trae.
 */

export type Destino = { tipo: 'conocimiento'; tema: string } | { tipo: 'acciones' };

export function leerDestino(texto: string): Destino | null {
  if (texto === 'acciones') return { tipo: 'acciones' };
  const m = /^conocimiento:([a-z_]+)$/.exec(texto);
  if (m && ESQUEMA_CONOCIMIENTO.some((e) => e.tema === m[1])) return { tipo: 'conocimiento', tema: m[1] };
  return null;
}

const MAX_TEXTO = 120_000; // un Word más largo que esto no es un documento de configuración

/** El esquema que el modelo debe llenar: el de la sección de destino. */
function herramienta(destino: Destino) {
  if (destino.tipo === 'acciones') {
    return {
      name: 'proponer_medios_de_pago',
      description: 'Entrega los medios de pago que aparecen en el documento.',
      input_schema: {
        type: 'object' as const,
        properties: {
          enlacesPayPal: {
            type: 'array',
            description: 'Cada enlace de PayPal de monto fijo que aparece en el documento.',
            items: {
              type: 'object',
              properties: {
                concepto: {
                  type: 'string',
                  enum: [...CONCEPTOS_ENLACE],
                  description:
                    'matricula = matrícula; abono_inicial = abono o pago inicial; arancel = cuota mensual, pago semestral o pago anual del arancel; contado = pago total al contado.',
                },
                montoUsd: { type: 'number', description: 'Monto exacto en dólares, como número.' },
                url: { type: 'string', description: 'El enlace completo, tal cual aparece.' },
              },
              required: ['concepto', 'montoUsd', 'url'],
            },
          },
          portalFlywire: { type: 'string', description: 'El enlace del portal de pagos sin monto (Flywire), si aparece. Vacío si no.' },
        },
        required: ['enlacesPayPal'],
      },
    };
  }
  const e = ESQUEMA_CONOCIMIENTO.find((x) => x.tema === destino.tema)!;
  const campos: Record<string, unknown> = {};
  for (const c of e.campos) {
    campos[c.clave] = {
      type: 'string',
      description: `${c.etiqueta}${c.ayuda ? `. ${c.ayuda}` : ''}${c.tipo === 'fecha' ? ' Formato AAAA-MM-DD.' : ''}${c.obligatorio ? '' : ' Vacío si el documento no lo dice.'}`,
    };
  }
  return {
    name: 'proponer_filas',
    description: `Entrega las filas de «${e.titulo}» que aparecen en el documento.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        entradas: {
          type: 'array',
          description: `${e.ayuda} Una fila por elemento del documento, en el orden en que aparecen.`,
          items: { type: 'object', properties: campos, required: e.campos.filter((c) => c.obligatorio).map((c) => c.clave) },
        },
        vigenteHasta: { type: 'string', description: 'Hasta cuándo es válida esta información según el documento (AAAA-MM-DD). Vacío si no lo dice.' },
      },
      required: ['entradas'],
    },
  };
}

const INSTRUCCIONES =
  'Traspasas el contenido de un documento oficial a un formulario. Reglas:\n' +
  '- Usa SOLO lo que dice el documento. No inventes, no completes ni supongas nada: si un dato no está, no lo incluyas.\n' +
  '- Copia los textos tal como están, sin resumir ni reescribir. Los enlaces, completos y exactos.\n' +
  '- Fechas en formato AAAA-MM-DD; montos como número en dólares.\n' +
  '- Si el documento no tiene nada de lo que se pide, entrega la lista vacía.';

export type ResultadoImportar = { ok: true; propuesta: Record<string, unknown> } | { ok: false; error: string };

/** Lee el documento y devuelve la propuesta para la sección de destino. */
export async function proponerDesdeDocumento(destino: Destino, documento: { nombre: string; contenido: Buffer }): Promise<ResultadoImportar> {
  let bloque: any;
  if (esPdf(documento.contenido)) {
    bloque = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: documento.contenido.toString('base64') } };
  } else if (esZip(documento.contenido)) {
    let texto: string;
    try {
      texto = textoDeDocx(documento.contenido);
    } catch {
      return { ok: false, error: 'No pudimos leer ese Word. Guárdalo de nuevo como .docx o expórtalo a PDF e inténtalo otra vez.' };
    }
    if (!texto) return { ok: false, error: 'El documento no tiene texto.' };
    if (texto.length > MAX_TEXTO) return { ok: false, error: 'El documento es demasiado largo para importarlo de una vez. Sube solo la parte que corresponde.' };
    bloque = { type: 'text', text: `Documento «${documento.nombre}»:\n\n${texto}` };
  } else {
    return { ok: false, error: 'Solo se pueden importar documentos Word (.docx) o PDF.' };
  }

  const h = herramienta(destino);
  const resp = await anthropic.messages.create({
    model: REASONER,
    max_tokens: 8000,
    temperature: 0,
    system: INSTRUCCIONES,
    tools: [h] as any,
    tool_choice: { type: 'tool', name: h.name },
    messages: [{ role: 'user', content: [bloque, { type: 'text', text: 'Extrae lo que corresponde y entrégalo con la herramienta.' }] }],
  });
  recordTokens((resp as any).usage);
  void dbAcumularTokens((resp as any).usage);
  const uso = (resp.content as any[]).find((b) => b.type === 'tool_use' && b.name === h.name);
  if (!uso) return { ok: false, error: 'No se pudo extraer contenido de ese documento.' };
  return { ok: true, propuesta: uso.input as Record<string, unknown> };
}
