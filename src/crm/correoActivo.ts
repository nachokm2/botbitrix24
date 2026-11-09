import { config } from '../config';
import { marca } from '../marca';

/** ¿Puede el bot enviar la información del programa por correo (crm/correoInformacion.ts)? Hace falta
 *  que la marca lo tenga y el buzón de Bitrix desde el que sale (CORREO_INFO_REMITENTE). Sin eso la
 *  herramienta no se ofrece y el prompt no promete correos.
 *
 *  Vive aparte, sin más dependencias que la configuración, porque lo leen el perfil del canal y el
 *  prompt al cargar: importarlo desde el módulo del envío arrastraría medio bot a esa carga. */
export function correoInformacionActivo(): boolean {
  return marca.correoInformacion && /<[^\s@<>]+@[^\s@<>]+>|^[^\s@]+@[^\s@]+$/.test(config.correoInfoRemitente);
}
