import { BECA_CARVER, type ProgramaCarver } from '../core/condicionesCarver';
import { REABRE_POR_DEFECTO } from '../core/ajustesProgramas';

/**
 * El correo con la información del programa, en HTML comercial. Es PURO: todo lo que dice viene en
 * los datos, que salen de la planilla, el calendario del panel y la ficha del programa
 * (crm/correoInformacion.ts). Nada lo escribe el modelo.
 *
 * Va como el cuerpo de una actividad de correo del CRM, enviada desde el buzón de admisión. Por eso es
 * HTML de correo y no de página: tablas, estilos en línea, una sola columna de 600 px que se lee bien
 * en el teléfono, botones hechos con celdas y sin imágenes salvo la cabecera de Carver. Sin emojis: el
 * texto se guarda en Bitrix y los caracteres de 4 bytes se cortan.
 */

export type DatosHtml = {
  nombre?: string;
  programa: ProgramaCarver;
  /** "4 años", "12 meses de clases (12 módulos)": de la ficha del programa. */
  duracion?: string;
  ingreso?: { inicio: string; cierre?: string } | null;
  /** Enlace verificado al brochure (core/brochures.ts). Va como botón y no como adjunto: adjuntado por
   *  esta vía, Bitrix le cambia el nombre al archivo ("….pdf_bxacid….crm"). */
  brochureUrl?: string;
  asesor?: { nombre?: string; whatsapp?: string; email?: string; formulario?: string } | null;
  /** Fecha de hoy (YYYY-MM-DD, hora de Chile), para contar los días que quedan para postular. */
  hoy: string;
};

const C = {
  fondo: '#EEF4F3',
  tinta: '#12343B',
  texto: '#3D4F4D',
  suave: '#6B7D7A',
  marca: '#006166',
  marcaClara: '#00897B',
  menta: '#E6F4F1',
  borde: '#DCE7E5',
  acento: '#FFB81C',
  acentoTinta: '#3A2A00',
};
const FUENTE = 'Arial,Helvetica,sans-serif';

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
const conDia = (iso: string) => {
  const d = fechaUtc(iso);
  return d ? `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} de ${MESES[d.getUTCMonth()]}` : '';
};
const conAnio = (iso: string) => {
  const d = fechaUtc(iso);
  return d ? `${conDia(iso)} de ${d.getUTCFullYear()}` : '';
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

/** Un botón que se ve igual en Gmail, Outlook y el teléfono: una celda con fondo y un enlace. */
function boton(texto: string, url: string, principal: boolean): string {
  const fondo = principal ? C.marcaClara : '#ffffff';
  const color = principal ? '#ffffff' : C.marca;
  const borde = principal ? C.marcaClara : C.marca;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 12px;"><tr><td align="center" bgcolor="${fondo}" style="border-radius:8px;border:2px solid ${borde};"><a href="${esc(url)}" target="_blank" style="display:inline-block;padding:14px 34px;font-family:${FUENTE};font-size:16px;font-weight:bold;color:${color};text-decoration:none;border-radius:8px;">${esc(texto)}</a></td></tr></table>`;
}

function filaPago(titulo: string, detalle: string, monto: string, unidad: string, destacado: boolean): string {
  const borde = destacado ? `2px solid ${C.marcaClara}` : `1px solid ${C.borde}`;
  const sello = destacado
    ? `<span style="display:inline-block;margin-left:8px;padding:3px 9px;border-radius:999px;background-color:${C.marcaClara};color:#ffffff;font-size:10px;font-weight:bold;letter-spacing:.08em;vertical-align:middle;">MAYOR AHORRO</span>`
    : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 10px;border:${borde};border-radius:10px;background-color:#ffffff;"><tr>
<td style="padding:16px 18px;font-family:${FUENTE};vertical-align:middle;"><p style="margin:0 0 4px;font-size:15px;font-weight:bold;color:${C.tinta};">${esc(titulo)}${sello}</p><p style="margin:0;font-size:13px;line-height:1.5;color:${C.suave};">${esc(detalle)}</p></td>
<td align="right" style="padding:16px 18px;font-family:${FUENTE};vertical-align:middle;white-space:nowrap;"><p style="margin:0;font-size:22px;font-weight:bold;color:${C.marca};">${esc(monto)}</p><p style="margin:0;font-size:12px;color:${C.suave};">${esc(unidad)}</p></td>
</tr></table>`;
}

function beneficio(titulo: string, texto: string): string {
  return `<tr><td width="34" style="vertical-align:top;padding:0 0 14px;"><div style="width:24px;height:24px;line-height:24px;border-radius:12px;background-color:${C.menta};color:${C.marcaClara};font-family:${FUENTE};font-size:14px;font-weight:bold;text-align:center;">&#10003;</div></td>
<td style="vertical-align:top;padding:0 0 14px;font-family:${FUENTE};"><p style="margin:0 0 2px;font-size:15px;font-weight:bold;color:${C.tinta};">${esc(titulo)}</p><p style="margin:0;font-size:14px;line-height:1.5;color:${C.texto};">${esc(texto)}</p></td></tr>`;
}

/** El asunto: personal y con el programa, sin mayúsculas ni signos de oferta que lo manden a spam. */
export function asuntoCorreoInformacion(nombre: string | undefined, programa: string): string {
  const n = esc(nombre).split(/\s+/)[0];
  return n ? `${n}, aquí tiene la información de la ${programa}` : `Aquí tiene la información de la ${programa}`;
}

export function htmlCorreoInformacion(d: DatosHtml): string {
  const p = d.programa;
  const nombre = esc(d.nombre).split(/\s+/)[0];
  const sinCupos = !p.cotizable && p.motivoNoCotizable === 'cupos completos';
  const a = d.asesor ?? null;
  const whatsapp = soloDigitos(a?.whatsapp);
  const formulario = httpsSeguro(a?.formulario);
  const partes: string[] = [];

  // Texto oculto que muchos lectores de correo muestran junto al asunto.
  partes.push(
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">Su beca del ${p.becaPct ?? 50} %, las formas de pago${!sinCupos && d.ingreso?.inicio ? ' y las fechas del próximo ingreso' : ''}, en un solo lugar.</div>`,
  );

  // Cabecera de marca y programa.
  const etiquetas = ['100 % en línea', 'Clases en vivo en español', d.duracion ? esc(d.duracion.replace(/\s*\(.*\)\s*$/, '')) : '']
    .filter(Boolean)
    .join(' &nbsp;·&nbsp; ');
  partes.push(`<tr><td style="padding:0;"><img src="https://postgrados.uautonoma.cl/content/uploads/2025/01/Header-Mailing-1.png" width="600" alt="Carver University" style="display:block;border:0;width:100%;max-width:600px;height:auto;"></td></tr>
<tr><td style="background-color:${C.marca};padding:30px 32px 32px;font-family:${FUENTE};">
<p style="margin:0 0 8px;font-size:12px;font-weight:bold;letter-spacing:.14em;color:#9FE3D6;">INFORMACIÓN DE SU PROGRAMA</p>
<p style="margin:0 0 12px;font-size:28px;line-height:1.2;font-weight:bold;color:#ffffff;">${esc(p.nombre)}</p>
<p style="margin:0;font-size:14px;color:#D7ECEA;">${etiquetas}</p>
</td></tr>`);

  // Saludo.
  partes.push(`<tr><td style="padding:28px 32px 8px;font-family:${FUENTE};">
<p style="margin:0 0 10px;font-size:18px;font-weight:bold;color:${C.tinta};">${nombre ? `Hola, ${nombre}:` : 'Hola:'}</p>
<p style="margin:0;font-size:15px;line-height:1.6;color:${C.texto};">Gracias por su interés. Tal como conversamos, aquí tiene en un solo lugar el valor con su beca, las formas de pago y las fechas, para que pueda decidir con calma.</p>
</td></tr>`);

  // Cupos completos: va antes del precio, para que nadie crea que puede inscribirse hoy.
  if (sinCupos) {
    partes.push(`<tr><td style="padding:16px 32px 0;font-family:${FUENTE};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#FFF6E0;border:1px solid #F5D38A;border-radius:10px;"><tr><td style="padding:16px 18px;font-size:14px;line-height:1.5;color:${C.acentoTinta};"><strong>Cupos completos.</strong> La matrícula reabre en ${esc(p.reabre || REABRE_POR_DEFECTO)}. Le dejo el valor para que pueda planificarlo con tiempo.</td></tr></table></td></tr>`);
  }

  // El precio, protagonista.
  if (p.arancelLista && p.arancelConBeca && p.becaPct) {
    partes.push(`<tr><td style="padding:20px 32px 8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${C.menta};border:1px solid #BFE3DA;border-radius:12px;"><tr><td align="center" style="padding:26px 20px;font-family:${FUENTE};">
<span style="display:inline-block;padding:5px 12px;border-radius:999px;background-color:${C.acento};color:${C.acentoTinta};font-size:11px;font-weight:bold;letter-spacing:.06em;">${esc(BECA_CARVER.toUpperCase())} &middot; ${p.becaPct} %</span>
<p style="margin:16px 0 2px;font-size:14px;color:${C.suave};">Arancel de lista <span style="text-decoration:line-through;">${usd(p.arancelLista)}</span></p>
<p style="margin:0;font-size:40px;line-height:1.1;font-weight:bold;color:${C.marca};">${usd(p.arancelConBeca)}</p>
<p style="margin:4px 0 0;font-size:14px;color:${C.texto};">con su beca del ${p.becaPct} %</p>
</td></tr></table></td></tr>`);
  }

  // Formas de pago.
  const filas: string[] = [];
  if (p.mensualidades) {
    const regular = p.matriculaRegular && p.matricula !== undefined && p.matriculaRegular > p.matricula ? ` (regular ${usd(p.matriculaRegular)})` : '';
    filas.push(
      filaPago(
        'Mensualidades',
        `${p.mensualidades.n} cuotas${p.matricula ? ` · matrícula de ${usd(p.matricula)}${regular}` : ''}`,
        usd(p.mensualidades.monto),
        'al mes',
        false,
      ),
    );
  }
  if (p.semestral) {
    filas.push(filaPago('Semestral', `${p.semestral.n} pagos · total ${usd(p.semestral.n * p.semestral.monto)} · sin matrícula`, usd(p.semestral.monto), 'por semestre', false));
  }
  if (p.contado) {
    const porAnio = p.contado.anios && p.contado.anios > 1 && p.contado.porAnio;
    filas.push(
      porAnio
        ? filaPago('Contado', `${p.contado.anios} años · total ${usd(p.contado.total)} · sin matrícula`, usd(p.contado.porAnio), 'al año', true)
        : filaPago('Contado', 'Un solo pago · sin matrícula', usd(p.contado.total), 'pago único', true),
    );
  }
  if (filas.length) {
    partes.push(`<tr><td style="padding:24px 32px 4px;font-family:${FUENTE};">
<p style="margin:0 0 4px;font-size:19px;font-weight:bold;color:${C.tinta};">Elija cómo pagar</p>
<p style="margin:0 0 14px;font-size:14px;color:${C.suave};">Tres formas, todas con su beca incluida.</p>
${filas.join('\n')}
<p style="margin:6px 0 0;font-size:12px;line-height:1.5;color:${C.suave};">El semestral y el contado ya incluyen la beca y un descuento adicional. Valores en dólares estadounidenses (USD).</p>
</td></tr>`);
  }

  // Próximo ingreso, con los días que quedan.
  if (!sinCupos && d.ingreso?.inicio && conAnio(d.ingreso.inicio)) {
    const quedan = d.ingreso.cierre ? diasEntre(d.hoy, d.ingreso.cierre) : null;
    const urgencia =
      quedan === null || quedan < 0 || quedan > 45
        ? ''
        : `<span style="display:inline-block;margin-top:14px;padding:6px 14px;border-radius:999px;background-color:${C.acento};color:${C.acentoTinta};font-size:13px;font-weight:bold;">${quedan === 0 ? 'La postulación cierra hoy' : quedan === 1 ? 'Queda 1 día para postular' : `Quedan ${quedan} días para postular`}</span>`;
    partes.push(`<tr><td style="padding:24px 32px 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${C.tinta};border-radius:12px;"><tr><td style="padding:24px 24px;font-family:${FUENTE};">
<p style="margin:0 0 10px;font-size:12px;font-weight:bold;letter-spacing:.14em;color:#9FE3D6;">PRÓXIMO INGRESO</p>
<p style="margin:0 0 4px;font-size:14px;color:#BFD3D0;">Inicio de clases</p>
<p style="margin:0 0 12px;font-size:22px;font-weight:bold;color:#ffffff;">${esc(conAnio(d.ingreso.inicio))}</p>
${d.ingreso.cierre ? `<p style="margin:0;font-size:15px;color:#E6F0EE;">Postulación abierta hasta el <strong>${esc(conDia(d.ingreso.cierre))}</strong></p>` : ''}
${urgencia}
</td></tr></table></td></tr>`);
  }

  // Por qué Carver: solo lo aprobado.
  partes.push(`<tr><td style="padding:26px 32px 6px;font-family:${FUENTE};">
<p style="margin:0 0 16px;font-size:19px;font-weight:bold;color:${C.tinta};">Por qué Carver University</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${beneficio('Título oficial de Estados Unidos', 'Licencia N.º 12743 de la Commission for Independent Education del estado de Florida.')}
${beneficio('100 % en línea y en español', 'Clases en vivo, desde su país, sin interrumpir su trabajo.')}
${beneficio('Acompañamiento en su admisión', 'Le acompañamos paso a paso, desde la postulación hasta su matrícula.')}
</table>
</td></tr>`);

  // Llamados a la acción.
  const brochure = httpsSeguro(d.brochureUrl);
  const botones: string[] = [];
  if (formulario && !sinCupos) botones.push(boton('Postular ahora', formulario, true));
  if (whatsapp) botones.push(boton('Escribir por WhatsApp', `https://wa.me/${whatsapp}`, !botones.length));
  if (brochure) botones.push(boton('Ver el brochure (PDF)', brochure, !botones.length));
  if (botones.length) partes.push(`<tr><td align="center" style="padding:22px 32px 8px;">${botones.join('')}</td></tr>`);

  // Quién le acompaña.
  const contacto = [
    whatsapp ? `WhatsApp: ${esc(telefonoLegible(`+${whatsapp}`))}` : '',
    a?.email ? `Correo: ${esc(a.email)}` : '',
  ].filter(Boolean);
  partes.push(`<tr><td style="padding:18px 32px 28px;font-family:${FUENTE};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${C.borde};"><tr><td style="padding-top:20px;">
<p style="margin:0 0 6px;font-size:15px;line-height:1.6;color:${C.texto};">Cualquier duda, responda este correo o escríbanos por WhatsApp. Será un gusto acompañarle.</p>
<p style="margin:14px 0 0;font-size:15px;color:${C.texto};">Saludos cordiales,</p>
<p style="margin:2px 0 0;font-size:16px;font-weight:bold;color:${C.tinta};">${a?.nombre ? esc(a.nombre) : 'Equipo de Admisión'}</p>
<p style="margin:0;font-size:14px;color:${C.marca};">Carver University</p>
${contacto.length ? `<p style="margin:8px 0 0;font-size:13px;line-height:1.6;color:${C.suave};">${contacto.join('<br>')}</p>` : ''}
</td></tr></table>
</td></tr>`);

  // Pie.
  partes.push(`<tr><td style="background-color:${C.marca};padding:20px 32px;font-family:${FUENTE};font-size:11px;line-height:1.6;color:#D7ECEA;">
<strong style="color:#ffffff;">Carver University</strong> &middot; Florida, Estados Unidos &middot; Licencia N.º 12743, Commission for Independent Education<br>
Recibe este correo porque solicitó información sobre uno de nuestros programas. Valores vigentes a la fecha de envío.
</td></tr>`);

  const [oculto, ...filasTabla] = partes;
  return `${oculto}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0;padding:0;background-color:${C.fondo};"><tr><td align="center" style="padding:24px 10px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#ffffff;border-radius:14px;overflow:hidden;border:1px solid ${C.borde};">
${filasTabla.join('\n')}
</table></td></tr></table>`;
}
