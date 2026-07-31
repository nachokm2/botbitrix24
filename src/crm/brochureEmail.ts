import { PDFDocument } from 'pdf-lib';
import { getJson, setJson } from '../store/kv';

// Acumulación de "programas de interés" por deal + render del cuerpo del correo del brochure.
// El campo UF de programa (config.ufPrograma) sigue guardando solo el ÚLTIMO programa mencionado
// (para reportería/dashboard, sin cambios); esta acumulación es aparte: junta TODOS los programas
// distintos que la persona mencionó durante la conversación, para mandarlos en un solo correo.

const KEY = (dealId: number) => `brochure:programas:${dealId}`;
const TTL_SEC = 60 * 60 * 24 * 60; // 60 días — holgado para la vida útil de un deal en curso

export async function obtenerProgramasAcumulados(dealId: number): Promise<string[]> {
  return (await getJson<string[]>(KEY(dealId))) ?? [];
}

/** Agrega `programa` a la lista acumulada del deal si es distinto a los ya guardados.
 *  Devuelve la lista resultante y si realmente se agregó algo nuevo (para no re-adjuntar/re-enviar
 *  cuando la IA repite el mismo programa en cada turno). */
export async function agregarProgramaAcumulado(
  dealId: number,
  programa: string,
): Promise<{ programas: string[]; esNuevo: boolean }> {
  const actuales = await obtenerProgramasAcumulados(dealId);
  if (actuales.includes(programa)) return { programas: actuales, esNuevo: false };
  const nuevos = [...actuales, programa];
  await setJson(KEY(dealId), nuevos, TTL_SEC);
  return { programas: nuevos, esNuevo: true };
}

/** Fusiona varios PDF en uno solo (mismo orden de la lista), para adjuntar un único archivo aunque
 *  haya varios programas de interés — evita depender de campos UF de archivo múltiple (poco
 *  confiables/lentos de crear en Bitrix24) o de un formato de "varios adjuntos" no verificado en
 *  la actividad CrmSendEmailActivity. */
export async function fusionarBrochures(pdfs: Buffer[]): Promise<Buffer> {
  if (pdfs.length <= 1) return pdfs[0] ?? Buffer.alloc(0);
  const merged = await PDFDocument.create();
  for (const buf of pdfs) {
    const doc = await PDFDocument.load(buf);
    const paginas = await merged.copyPages(doc, doc.getPageIndices());
    paginas.forEach((p) => merged.addPage(p));
  }
  return Buffer.from(await merged.save());
}

export type CuerpoBrochureInput = {
  nombre: string;
  programas: string[];
  /** Celular del asesor responsable del deal (ASSIGNED_BY), para los botones de llamar/WhatsApp. */
  telefonoAsesor?: string;
};

/** Cuerpo EN TEXTO PLANO del correo de brochure(s) — la plantilla bizproc solo referencia este
 *  campo ({=Document:UF_CUERPO_BROCHURE_HTML}), así que el render completo (con TODOS los
 *  programas acumulados) vive acá, ya que Bitrix no soporta repetir bloques por cada programa
 *  dentro de un CrmSendEmailActivity. Es texto plano (no HTML) por dos límites de la plataforma,
 *  ambos confirmados a mano:
 *  1) Bitrix escapa el HTML de los valores de campos Document al resolver el placeholder (a
 *     diferencia del texto ESTÁTICO de la plantilla, que sí sale como HTML real) — un
 *     `{=Document:...}` con MessageTextType "html" igual termina mostrando "&lt;b&gt;" literal.
 *  2) Los emoji (fuera del BMP, 4 bytes UTF-8) truncan en seco la columna del campo UF "string"
 *     donde se guarda este cuerpo — y las entidades HTML numéricas tampoco sirven de escape,
 *     porque el punto (1) las escapa también (el "&" se vuelve "&amp;"). */
export function renderCuerpoBrochureEmail(input: CuerpoBrochureInput): string {
  const { nombre, programas, telefonoAsesor } = input;
  const varios = programas.length > 1;

  const intro = varios
    ? 'Muchas gracias por tu tiempo. Tal como conversamos, te envío adjuntos los brochures de los programas que fueron de tu interés para que puedas revisarlos con tranquilidad.'
    : 'Muchas gracias por tu tiempo. Tal como conversamos, te envío adjunto el brochure del programa que fue de tu interés para que puedas revisarlo con tranquilidad.';

  const bloquesPrograma = programas
    .map((p, i) => `${i + 1}. ${p}\n   Archivo adjunto: Brochure ${p} (PDF)`)
    .join('\n\n');

  const telefonoLimpio = telefonoAsesor?.replace(/[^\d+]/g, '');
  const ayuda = telefonoLimpio
    ? [
        '---',
        '¿Necesitas ayuda?',
        'Si deseas resolver alguna duda o recibir orientación personalizada, puedes comunicarte directamente con tu asesor.',
        `Llamar a tu asesor: ${telefonoLimpio}`,
        `Continuar por WhatsApp: https://wa.me/${telefonoLimpio}`,
      ].join('\n')
    : '';

  return [
    `Hola, ${nombre}.`,
    intro,
    'Si tienes dudas sobre el plan de estudios, modalidad, aranceles, descuentos o el proceso de admisión, estaré encantado de ayudarte.',
    `${varios ? 'Programas' : 'Programa'} de interés:\n\n${bloquesPrograma}`,
    ayuda,
    'Quedamos atentos para acompañarte durante todo tu proceso de admisión.',
  ]
    .filter(Boolean)
    .join('\n\n');
}
