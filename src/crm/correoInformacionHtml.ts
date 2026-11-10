import { BECA_CARVER, type ProgramaCarver } from '../core/condicionesCarver';
import { REABRE_POR_DEFECTO } from '../core/ajustesProgramas';

/**
 * El correo con la información del programa, con formato de carta de admisión universitaria. Es PURO:
 * todo lo que dice viene en los datos, que salen de la planilla, el calendario del panel y la ficha del
 * programa (crm/correoInformacion.ts). Nada lo escribe el modelo.
 *
 * Diseño académico, no de campaña (pedido del usuario, 10-11-2026): tipografía con serifa, una paleta
 * sobria (el verde de Carver, un dorado tenue y fondo marfil), la información en tablas como un
 * arancel oficial, y la firma de quien atiende al final, como una carta.
 *
 * Va como el cuerpo de una actividad de correo del CRM, enviada desde el buzón de admisión. Por eso es
 * HTML de correo y no de página: tablas, estilos en línea, una sola columna de 600 px que se lee en el
 * teléfono, el botón hecho con una celda y sin imágenes salvo la cabecera de Carver. Sin emojis: el
 * texto se guarda en Bitrix y los caracteres de 4 bytes se cortan.
 */

export type DatosHtml = {
  nombre?: string;
  programa: ProgramaCarver;
  /** "4 años", "12 meses de clases (12 módulos)": de la ficha del programa. */
  duracion?: string;
  ingreso?: { inicio: string; cierre?: string } | null;
  /** Enlace verificado al brochure (core/brochures.ts). Va como enlace y no como adjunto: adjuntado por
   *  esta vía, Bitrix le cambia el nombre al archivo ("….pdf_bxacid….crm"). */
  brochureUrl?: string;
  asesor?: { nombre?: string; whatsapp?: string; email?: string; formulario?: string } | null;
  /** Fecha de hoy (YYYY-MM-DD, hora de Chile): la fecha de la carta y los días que quedan para postular. */
  hoy: string;
};

const C = {
  fondo: '#F4F1EA',
  papel: '#FFFFFF',
  marfil: '#FBF9F4',
  tinta: '#1F2A2E',
  texto: '#3A4448',
  suave: '#6E7679',
  marca: '#006166',
  oro: '#A8894A',
  filete: '#E4DDCF',
};
const SERIFA = "Georgia,'Times New Roman',Times,serif";
const SANS = 'Arial,Helvetica,sans-serif';

const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/[\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .trim();

const usd = (n?: number) => `USD ${(n ?? 0).toLocaleString('es-CL')}`;

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const fechaUtc = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
};
/** "lunes 23 de noviembre de 2026" (con el día de la semana) o "23 de noviembre de 2026". */
const fechaLarga = (iso: string, conDiaSemana = true) => {
  const d = fechaUtc(iso);
  if (!d) return '';
  const base = `${d.getUTCDate()} de ${MESES[d.getUTCMonth()]} de ${d.getUTCFullYear()}`;
  return conDiaSemana ? `${DIAS[d.getUTCDay()]} ${base}` : base;
};

/** Días enteros de `desde` a `hasta` (fechas YYYY-MM-DD), o null. */
export function diasEntre(desde: string, hasta: string): number | null {
  const a = fechaUtc(desde);
  const b = fechaUtc(hasta);
  return a && b ? Math.round((b.getTime() - a.getTime()) / 86_400_000) : null;
}

const httpsSeguro = (u?: string) => {
  try {
    const x = new URL(String(u ?? ''));
    return x.protocol === 'https:' ? x.toString() : '';
  } catch {
    return '';
  }
};
const soloDigitos = (t?: string) => String(t ?? '').replace(/\D/g, '');
const telefonoLegible = (e164: string) => {
  const m = /^\+569(\d{4})(\d{4})$/.exec(e164);
  return m ? `+56 9 ${m[1]} ${m[2]}` : e164;
};

const enlace = (texto: string, url: string) =>
  `<a href="${esc(url)}" target="_blank" style="color:${C.marca};text-decoration:underline;">${esc(texto)}</a>`;

/** Encabezado de sección: versalitas en dorado y un filete fino, como en un prospecto. */
const tituloSeccion = (t: string) =>
  `<p style="margin:0 0 14px;padding:0 0 8px;border-bottom:1px solid ${C.filete};font-family:${SANS};font-size:11px;font-weight:bold;letter-spacing:.16em;color:${C.oro};">${esc(t.toUpperCase())}</p>`;

const celda = (contenido: string, estilo = '') =>
  `<td style="padding:11px 0;border-bottom:1px solid ${C.filete};font-family:${SERIFA};font-size:15px;line-height:1.45;color:${C.texto};vertical-align:top;${estilo}">${contenido}</td>`;

/** El asunto: formal, con el nombre y el programa, sin signos de oferta que lo manden a spam. */
export function asuntoCorreoInformacion(nombre: string | undefined, programa: string): string {
  const n = esc(nombre).split(/\s+/)[0];
  return n ? `${n}: información de la ${programa} | Carver University` : `Información de la ${programa} | Carver University`;
}

export function htmlCorreoInformacion(d: DatosHtml): string {
  const p = d.programa;
  const nombre = esc(d.nombre).split(/\s+/)[0];
  const sinCupos = !p.cotizable && p.motivoNoCotizable === 'cupos completos';
  const a = d.asesor ?? null;
  const whatsapp = soloDigitos(a?.whatsapp);
  const formulario = httpsSeguro(a?.formulario);
  const brochure = httpsSeguro(d.brochureUrl);
  const conIngreso = !sinCupos && !!d.ingreso?.inicio && !!fechaLarga(d.ingreso.inicio);
  const nivel = p.tipo === 'licenciatura' ? 'Licenciatura' : p.tipo === 'maestria' ? 'Maestría' : '';
  const filas: string[] = [];

  // Cabecera institucional y membrete.
  filas.push(`<tr><td style="padding:0;"><img src="https://postgrados.uautonoma.cl/content/uploads/2025/01/Header-Mailing-1.png" width="600" alt="Carver University" style="display:block;border:0;width:100%;max-width:600px;height:auto;"></td></tr>
<tr><td style="padding:0;height:3px;line-height:3px;font-size:0;background-color:${C.oro};">&nbsp;</td></tr>
<tr><td style="padding:22px 40px 0;font-family:${SANS};font-size:11px;letter-spacing:.14em;color:${C.suave};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="font-family:${SANS};font-size:11px;letter-spacing:.14em;color:${C.suave};">OFICINA DE ADMISIÓN</td>
<td align="right" style="font-family:${SERIFA};font-size:13px;letter-spacing:0;color:${C.suave};font-style:italic;">${esc(fechaLarga(d.hoy, false))}</td>
</tr></table></td></tr>`);

  // Título del programa.
  const ficha = [nivel, d.duracion ? esc(d.duracion.replace(/\s*\(.*\)\s*$/, '')) : '', '100 % en línea, con clases en vivo en español']
    .filter(Boolean)
    .join(' &nbsp;·&nbsp; ');
  filas.push(`<tr><td style="padding:26px 40px 6px;">
<p style="margin:0 0 6px;font-family:${SANS};font-size:11px;font-weight:bold;letter-spacing:.16em;color:${C.oro};">INFORMACIÓN ACADÉMICA Y DE ADMISIÓN</p>
<p style="margin:0 0 10px;font-family:${SERIFA};font-size:27px;line-height:1.25;font-weight:normal;color:${C.marca};">${esc(p.nombre)}</p>
<p style="margin:0;font-family:${SERIFA};font-size:14px;font-style:italic;color:${C.suave};">${ficha}</p>
</td></tr>`);

  // Saludo, como en una carta.
  filas.push(`<tr><td style="padding:22px 40px 4px;font-family:${SERIFA};font-size:16px;line-height:1.7;color:${C.texto};">
<p style="margin:0 0 14px;">${nombre ? `${nombre}, reciba un cordial saludo.` : 'Reciba un cordial saludo.'}</p>
<p style="margin:0;">Gracias por su interés en la ${esc(p.nombre)} de Carver University. Tal como conversamos, le comparto los aranceles vigentes con la beca${conIngreso ? ', las modalidades de pago y el calendario del próximo ingreso' : ' y las modalidades de pago'}, para que pueda revisarlos con tranquilidad.</p>
</td></tr>`);

  // Cupos completos: antes de los valores, para que nadie crea que puede inscribirse hoy.
  if (sinCupos) {
    filas.push(`<tr><td style="padding:18px 40px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-left:3px solid ${C.oro};background-color:${C.marfil};"><tr><td style="padding:14px 18px;font-family:${SERIFA};font-size:15px;line-height:1.6;color:${C.tinta};"><strong>Cupos completos.</strong> La matrícula de este programa reabre en ${esc(p.reabre || REABRE_POR_DEFECTO)}. Le comparto los valores para que pueda planificarlo con tiempo.</td></tr></table></td></tr>`);
  }

  // Aranceles, como una tabla oficial.
  if (p.arancelLista) {
    const filasArancel = [
      `<tr>${celda('Arancel de lista')}${celda(usd(p.arancelLista), 'text-align:right;white-space:nowrap;')}</tr>`,
    ];
    if (p.arancelConBeca && p.becaPct) {
      filasArancel.push(
        `<tr>${celda(`${esc(BECA_CARVER)} (${p.becaPct} %)`)}${celda(`&minus; ${usd(p.arancelLista - p.arancelConBeca)}`, `text-align:right;white-space:nowrap;color:${C.marca};`)}</tr>`,
        `<tr>${celda('<strong>Arancel con beca</strong>', `color:${C.tinta};border-bottom:2px solid ${C.marca};`)}${celda(`<strong>${usd(p.arancelConBeca)}</strong>`, `text-align:right;white-space:nowrap;font-size:18px;color:${C.marca};border-bottom:2px solid ${C.marca};`)}</tr>`,
      );
    }
    filas.push(`<tr><td style="padding:30px 40px 0;">${tituloSeccion('Aranceles y beca')}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${filasArancel.join('')}</table>
</td></tr>`);
  }

  // Modalidades de pago.
  const pagos: string[] = [];
  const filaPago = (modalidad: string, detalle: string, valor: string, unidad: string) =>
    `<tr>${celda(`<strong style="color:${C.tinta};">${esc(modalidad)}</strong><br><span style="font-size:13px;color:${C.suave};">${detalle}</span>`)}${celda(`<strong style="color:${C.marca};">${esc(valor)}</strong><br><span style="font-size:13px;color:${C.suave};">${esc(unidad)}</span>`, 'text-align:right;white-space:nowrap;padding-left:16px;')}</tr>`;
  if (p.mensualidades) {
    const regular = p.matriculaRegular && p.matricula !== undefined && p.matriculaRegular > p.matricula ? ` (regular ${usd(p.matriculaRegular)})` : '';
    pagos.push(filaPago('Mensual', `${p.mensualidades.n} cuotas${p.matricula ? `, más matrícula de ${usd(p.matricula)}${regular}` : ''}`, usd(p.mensualidades.monto), 'por mes'));
  }
  if (p.semestral) {
    pagos.push(filaPago('Semestral', `${p.semestral.n} pagos, sin matrícula (total ${usd(p.semestral.n * p.semestral.monto)})`, usd(p.semestral.monto), 'por semestre'));
  }
  if (p.contado) {
    const ahorro = `<br><em style="color:${C.oro};">Opción de mayor ahorro</em>`;
    pagos.push(
      p.contado.anios && p.contado.anios > 1 && p.contado.porAnio
        ? filaPago('Anual al contado', `${p.contado.anios} pagos anuales, sin matrícula (total ${usd(p.contado.total)})${ahorro}`, usd(p.contado.porAnio), 'por año')
        : filaPago('Al contado', `Pago único, sin matrícula${ahorro}`, usd(p.contado.total), 'pago único'),
    );
  }
  if (pagos.length) {
    filas.push(`<tr><td style="padding:30px 40px 0;">${tituloSeccion('Modalidades de pago')}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${pagos.join('')}</table>
<p style="margin:12px 0 0;font-family:${SERIFA};font-size:13px;line-height:1.55;font-style:italic;color:${C.suave};">Las modalidades semestral y al contado incluyen la beca y un descuento adicional. Valores expresados en dólares estadounidenses (USD).</p>
</td></tr>`);
  }

  // Calendario del próximo ingreso.
  if (conIngreso && d.ingreso) {
    const quedan = d.ingreso.cierre ? diasEntre(d.hoy, d.ingreso.cierre) : null;
    const plazo =
      quedan === null || quedan < 0 || quedan > 45
        ? ''
        : `<p style="margin:14px 0 0;font-family:${SERIFA};font-size:14px;font-style:italic;color:${C.marca};">${quedan === 0 ? 'La postulación cierra hoy.' : quedan === 1 ? 'Queda 1 día para completar su postulación.' : `Quedan ${quedan} días para completar su postulación.`}</p>`;
    const fila = (etiqueta: string, valor: string) =>
      `<tr><td style="padding:6px 0;font-family:${SANS};font-size:11px;letter-spacing:.12em;color:${C.suave};vertical-align:top;width:46%;">${esc(etiqueta.toUpperCase())}</td><td style="padding:6px 0;font-family:${SERIFA};font-size:16px;color:${C.tinta};vertical-align:top;">${esc(valor)}</td></tr>`;
    filas.push(`<tr><td style="padding:30px 40px 0;">${tituloSeccion('Calendario del próximo ingreso')}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${C.marfil};border:1px solid ${C.filete};"><tr><td style="padding:16px 20px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${d.ingreso.cierre ? fila('Cierre de postulación', fechaLarga(d.ingreso.cierre)) : ''}
${fila('Inicio de clases', fechaLarga(d.ingreso.inicio))}
</table>${plazo}
</td></tr></table>
</td></tr>`);
  }

  // Reconocimiento institucional: solo lo aprobado.
  filas.push(`<tr><td style="padding:30px 40px 0;">${tituloSeccion('Reconocimiento institucional')}
<p style="margin:0;font-family:${SERIFA};font-size:15px;line-height:1.7;color:${C.texto};">Carver University es una institución estadounidense con sede en Florida que opera bajo la Licencia N.º 12743 de la Commission for Independent Education del Florida Department of Education. Al egresar, recibirá un título oficial de Estados Unidos.</p>
</td></tr>`);

  // Próximos pasos.
  const pasos: string[] = [];
  if (brochure) pasos.push(`Revise el ${enlace('brochure del programa', brochure)}, con el detalle completo.`);
  if (!sinCupos) {
    const cierre = conIngreso && d.ingreso?.cierre ? ` antes del ${esc(fechaLarga(d.ingreso.cierre))}` : '';
    pasos.push(
      formulario
        ? `Complete su ${enlace('postulación en línea', formulario)}${cierre}.`
        : `Complete su postulación${cierre}; ${a?.nombre ? 'le acompaño' : 'le acompañamos'} en cada paso.`,
    );
  }
  pasos.push(
    whatsapp
      ? `Para cualquier consulta, responda este correo o escríbame por ${enlace('WhatsApp', `https://wa.me/${whatsapp}`)}.`
      : 'Para cualquier consulta, responda este correo y le contestaremos a la brevedad.',
  );
  filas.push(`<tr><td style="padding:30px 40px 0;">${tituloSeccion('Próximos pasos')}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${pasos
  .map(
    (t, i) =>
      `<tr><td width="30" style="padding:0 0 12px;font-family:${SERIFA};font-size:16px;color:${C.oro};vertical-align:top;">${i + 1}.</td><td style="padding:0 0 12px;font-family:${SERIFA};font-size:15px;line-height:1.6;color:${C.texto};vertical-align:top;">${t}</td></tr>`,
  )
  .join('')}
</table>
${
  formulario && !sinCupos
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:10px 0 0;"><tr><td bgcolor="${C.marca}" style="border-radius:3px;"><a href="${esc(formulario)}" target="_blank" style="display:inline-block;padding:13px 30px;font-family:${SANS};font-size:13px;font-weight:bold;letter-spacing:.1em;color:#ffffff;text-decoration:none;">INICIAR POSTULACIÓN</a></td></tr></table>`
    : ''
}
</td></tr>`);

  // Firma.
  const contacto = [whatsapp ? `WhatsApp ${esc(telefonoLegible(`+${whatsapp}`))}` : '', a?.email ? esc(a.email) : ''].filter(Boolean).join(' &nbsp;·&nbsp; ');
  filas.push(`<tr><td style="padding:34px 40px 36px;font-family:${SERIFA};">
<p style="margin:0 0 18px;font-size:16px;color:${C.texto};">Atentamente,</p>
<p style="margin:0;font-size:17px;font-weight:bold;color:${C.tinta};">${a?.nombre ? esc(a.nombre) : 'Oficina de Admisión'}</p>
<p style="margin:2px 0 0;font-family:${SANS};font-size:11px;letter-spacing:.14em;color:${C.oro};">ADMISIÓN &middot; CARVER UNIVERSITY</p>
${contacto ? `<p style="margin:8px 0 0;font-size:14px;color:${C.suave};">${contacto}</p>` : ''}
</td></tr>`);

  // Pie.
  filas.push(`<tr><td style="padding:20px 40px;background-color:${C.marfil};border-top:1px solid ${C.filete};font-family:${SERIFA};font-size:12px;line-height:1.6;color:${C.suave};">
Carver University &middot; Florida, Estados Unidos &middot; Licencia N.º 12743, Commission for Independent Education, Florida Department of Education.<br>
Recibió este correo porque solicitó información sobre uno de nuestros programas. Los valores son los vigentes a la fecha de envío.
</td></tr>`);

  const vistaPrevia = `Aranceles con la beca del ${p.becaPct ?? 50} %, modalidades de pago${conIngreso ? ' y calendario del próximo ingreso' : ''}.`;
  return `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(vistaPrevia)}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0;padding:0;background-color:${C.fondo};"><tr><td align="center" style="padding:28px 10px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:${C.papel};border:1px solid ${C.filete};">
${filas.join('\n')}
</table></td></tr></table>`;
}
