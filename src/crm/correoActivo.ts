import { config } from '../config';
import { marca } from '../marca';

/** ¿Puede el bot enviar la información del programa por correo (crm/correoInformacion.ts)? Hace falta
 *  que la marca lo tenga y que estén la plantilla de Bitrix y el campo del cuerpo. Sin eso la
 *  herramienta no se ofrece y el prompt no promete correos.
 *
 *  Vive aparte, sin más dependencias que la configuración, porque lo leen el perfil del canal y el
 *  prompt al cargar: importarlo desde el módulo del envío arrastraría medio bot a esa carga. */
export function correoInformacionActivo(): boolean {
  return marca.correoInformacion && !!config.bizprocTemplateCorreoInfo && !!config.ufCorreoInfoCuerpo;
}
