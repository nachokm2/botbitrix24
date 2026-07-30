import { config } from '../config';

// Cuerpo HTML institucional del correo del brochure (Universidad Autónoma de Chile — Postgrados).
// Reemplaza el armador que vivía en Bitrix: ahora el bot arma el HTML con el diseño del dossier de Rodrigo
// (índigo #273473 · navy #0f1332 · dorado #e6c877 · crema #fbfaf7) y lo escribe en el campo UF que el
// bizproc "sender" envía. Email-safe: tablas + CSS inline; imágenes (campus, sello CNA) servidas desde
// nuestro backend en /assets/email (ver index.ts). El PDF lo sigue adjuntando el bizproc.

/** Escapa texto para insertarlo seguro en HTML. */
function esc(s: string): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function construirCorreoBrochureHtml(opts: { nombre?: string; programa: string }): string {
  const base = (config.baseUrl || '').replace(/\/$/, '');
  const campus = `${base}/assets/email/campus.webp`;
  const cna = `${base}/assets/email/cna.png`;
  const nombre = (opts.nombre ?? '').trim();
  const saludo = nombre ? `Hola, <strong>${esc(nombre)}</strong>:` : 'Hola:';
  const programa = esc(opts.programa);
  const wa = config.admisionesWhatsapp;
  const tel = config.admisionesTelefono;

  const botonWa = wa
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;"><tr><td align="center" bgcolor="#273473" style="border-radius:6px;"><a href="${esc(wa)}" target="_blank" style="display:inline-block;padding:13px 30px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:6px;">Conversar por WhatsApp</a></td></tr></table>`
    : '';
  const lineaTel = tel
    ? `<p style="margin:0 0 24px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.65;color:#55535c;">O llámanos al <a href="tel:${esc(tel)}" style="color:#273473;text-decoration:none;font-weight:bold;">${esc(tel)}</a>.</p>`
    : '';

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0;padding:0;background-color:#e9e7e2;">
<tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e0ddd4;">
  <tr><td align="center" style="background-color:#0f1332;padding:24px 24px 20px;border-bottom:3px solid #e6c877;">
    <p style="margin:0 0 4px;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:.16em;color:#e6c877;text-transform:uppercase;font-weight:bold;">Dirección de Postgrados</p>
    <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:22px;line-height:1.2;color:#ffffff;font-weight:bold;">Universidad Autónoma de Chile</p>
  </td></tr>
  <tr><td style="padding:0;"><img src="${campus}" width="600" alt="Campus Universidad Autónoma de Chile" style="display:block;border:0;outline:none;text-decoration:none;width:100%;max-width:600px;height:auto;"></td></tr>
  <tr><td style="background-color:#fbfaf7;padding:20px 34px;border-bottom:1px solid #e4e2da;">
    <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:21px;line-height:1.25;color:#273473;font-weight:bold;">Información de tu programa</p>
  </td></tr>
  <tr><td style="padding:32px 34px 8px;">
    <p style="margin:0 0 18px;font-family:Georgia,'Times New Roman',serif;font-size:18px;color:#1a1a2e;">${saludo}</p>
    <p style="margin:0 0 16px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;color:#3d3b45;">Muchas gracias por tu tiempo. Tal como conversamos, te enviamos adjunto el <strong style="color:#273473;">brochure del programa</strong> que fue de tu interés, para que puedas revisarlo con tranquilidad.</p>
    <p style="margin:0 0 8px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;color:#3d3b45;">Si tienes dudas sobre el plan de estudios, la modalidad, los aranceles, los descuentos o el proceso de admisión, estaremos encantados de ayudarte.</p>
  </td></tr>
  <tr><td style="padding:14px 34px 24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#fbfaf7;border:1px solid #e4e2da;border-left:4px solid #e6c877;border-radius:8px;"><tr><td style="padding:20px 24px;">
      <p style="margin:0 0 7px;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:.1em;color:#273473;text-transform:uppercase;font-weight:bold;">Programa de interés</p>
      <p style="margin:0 0 12px;font-family:Georgia,'Times New Roman',serif;font-size:19px;line-height:1.3;color:#1a1a2e;font-weight:bold;">${programa}</p>
      <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#55535c;"><span style="vertical-align:middle;">&#128206; Adjunto: <strong style="color:#1a1a2e;">Brochure ${programa}</strong> (PDF)</span></p>
    </td></tr></table>
  </td></tr>
  <tr><td style="padding:0 34px 8px;">
    <hr style="border:0;border-top:1px solid #e4e2da;margin:0 0 22px;">
    <p style="margin:0 0 6px;font-family:Georgia,'Times New Roman',serif;font-size:17px;color:#273473;font-weight:bold;">¿Necesitas ayuda?</p>
    <p style="margin:0 0 18px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.65;color:#55535c;">Para resolver cualquier duda o recibir orientación personalizada, puedes comunicarte con tu asesor de admisión:</p>
    ${botonWa}
    ${lineaTel}
    <p style="margin:0 0 28px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.65;color:#3d3b45;">Quedamos atentos para acompañarte durante todo tu proceso de admisión.</p>
  </td></tr>
  <tr><td style="background-color:#0f1332;padding:24px 34px;border-top:3px solid #e6c877;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="vertical-align:top;">
        <p style="margin:0 0 4px;font-family:Georgia,'Times New Roman',serif;font-size:16px;color:#ffffff;font-weight:bold;">Universidad Autónoma de Chile</p>
        <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:.05em;color:#e6c877;">Dirección de Postgrados · Admisión</p>
      </td>
      <td align="right" style="vertical-align:top;width:150px;"><img src="${cna}" width="140" alt="Universidad acreditada — CNA Chile" style="display:block;border:0;outline:none;text-decoration:none;width:140px;max-width:140px;height:auto;"></td>
    </tr></table>
    <p style="margin:14px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.55;color:#b8b5c0;">Este mensaje fue enviado porque solicitaste información sobre nuestros programas de postgrado. Los valores y condiciones son referenciales y están sujetos a confirmación en el proceso de admisión.</p>
  </td></tr>
</table>
</td></tr>
</table>`;
}
