import { callCrm } from '../bitrix/client';
import { config } from '../config';
import { audit } from '../obs/audit';
import { log } from '../log';
import type { Auth } from '../store';
import type { CrmEntities } from './entities';

/**
 * Ficha de matrícula: los antecedentes que antes se pedían por un formulario externo.
 *
 * Cada asesor tenía su propio formulario de postulación y le mandaba el enlace al cliente. Pedirle
 * los mismos datos en la conversación es equivalente —es el mismo formulario, escrito a mano— y
 * evita el salto a otra página, que es donde se cae la mitad de la gente.
 *
 * Dos resguardos, porque acá se escriben datos personales en una ficha real:
 *   - Solo se escribe lo que el cliente ENTREGÓ. Un campo que no mandó no se toca, nunca se deduce.
 *   - La negociación se mueve a "Pendiente de Firma" SOLO con la ficha completa, foto de la cédula
 *     incluida. Una etapa que dice "pendiente de firma" sin los antecedentes es una etapa que miente,
 *     y quien la vea en el embudo va a creer que puede seguir.
 */

/** Los 14 antecedentes, en el orden en que se piden, agrupados como se le piden al cliente. */
export type DatosMatricula = {
  nombres?: string;
  apellidoPaterno?: string;
  apellidoMaterno?: string;
  dni?: string;
  nacionalidad?: string;
  fechaNacimiento?: string;
  domicilio?: string;
  celular?: string;
  emailPersonal?: string;
  tituloGrado?: string;
  institucionTitulo?: string;
  anioTitulo?: string;
  codigoPostal?: string;
};

/** Qué falta todavía, con el nombre que entiende una persona. */
const ETIQUETAS: Record<keyof DatosMatricula | 'fotoCedula', string> = {
  nombres: 'nombres',
  apellidoPaterno: 'apellido paterno',
  apellidoMaterno: 'apellido materno',
  dni: 'cédula o DNI',
  nacionalidad: 'nacionalidad',
  fechaNacimiento: 'fecha de nacimiento',
  domicilio: 'domicilio particular',
  celular: 'número de celular',
  emailPersonal: 'email personal',
  tituloGrado: 'nombre del título o grado académico',
  institucionTitulo: 'institución donde lo obtuvo',
  anioTitulo: 'año de obtención del título',
  codigoPostal: 'código postal',
  fotoCedula: 'foto de su cédula o DNI',
};

const CLAVES = Object.keys(ETIQUETAS).filter((k) => k !== 'fotoCedula') as Array<keyof DatosMatricula>;

export type ResultadoMatricula = {
  ok: boolean;
  guardados: string[];
  /** Lo que todavía falta, en castellano, para que el bot sepa qué pedir sin repetir lo que ya tiene. */
  faltan: string[];
  completo: boolean;
  movidoAPendienteDeFirma?: boolean;
  nota: string;
};

const limpio = (v: unknown) => String(v ?? '').trim();

/** Fecha en el formato que acepta Bitrix. Si no se entiende, NO se inventa: se deja pedir de nuevo. */
function fechaBitrix(valor: string): string | null {
  const v = limpio(valor);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  // dd/mm/aaaa y dd-mm-aaaa, que es como la escribe la gente en Latinoamérica.
  m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(v);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

/**
 * La nacionalidad en el portal es un DESPLEGABLE de países, no texto libre, así que hay que mandar
 * el id del valor y no la palabra. La lista se lee de Bitrix y se cachea: si mañana agregan un país
 * —hoy falta República Dominicana, que es uno de los cinco mercados de Carver— empieza a funcionar
 * sin tocar código. Lo que no esté en la lista cae en "Otros" antes que trabar la ficha.
 */
let cacheNacionalidades: { at: number; items: Array<{ ID: string; VALUE: string }> } | null = null;
const CACHE_MS = 6 * 3600_000;

const sinTildes = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** "chileno", "chilena", "soy de Chile" → "chile". El gentilicio es como lo dice la gente. */
function raizPais(valor: string): string {
  return sinTildes(valor)
    .replace(/^(soy |nac[ií] en |de )/, '')
    .replace(/(n[oa]|ñ[oa]|en[oa]|an[oa]|in[oa]|e[nñ]a)$/u, '')
    .trim();
}

async function idNacionalidad(valor: string, auth: Auth): Promise<string | null> {
  if (!config.ufNacionalidad) return null;
  try {
    if (!cacheNacionalidades || Date.now() - cacheNacionalidades.at > CACHE_MS) {
      const f: any = await callCrm('crm.contact.fields', {}, auth);
      const items = f?.[config.ufNacionalidad]?.items;
      if (!Array.isArray(items)) return null;
      cacheNacionalidades = { at: Date.now(), items };
    }
    const items = cacheNacionalidades.items;
    const pedido = sinTildes(valor);
    const raiz = raizPais(valor);
    const exacto = items.find((i) => sinTildes(i.VALUE) === pedido);
    if (exacto) return exacto.ID;
    // Gentilicio. Los del español no son regulares —"ecuatoriano" no sale de "Ecuador" quitando el
    // sufijo— así que se compara por prefijo común: "ecua" basta para Ecuador, "chil" para Chile.
    // Se exige que calce con UN SOLO país: ante dos candidatos no se elige, porque escribir la
    // nacionalidad equivocada en una ficha de matrícula es peor que dejarla en "Otros".
    if (raiz.length >= 4) {
      const prefijo = raiz.slice(0, 4);
      const candidatos = items.filter((i) => sinTildes(i.VALUE).startsWith(prefijo));
      if (candidatos.length === 1) return candidatos[0].ID;
    }
    return items.find((i) => sinTildes(i.VALUE) === 'otros')?.ID ?? null;
  } catch (e) {
    log.warn('no se pudo leer la lista de nacionalidades', { err: String(e) });
    return null;
  }
}

/** Solo el año: "2018", "año 2018", "2018." */
function anioDe(valor: string): string | null {
  const m = /\b(19|20)\d{2}\b/.exec(limpio(valor));
  return m ? m[0] : null;
}

/**
 * Guarda en el CONTACTO lo que el cliente haya entregado y dice qué falta.
 *
 * El apellido materno va junto al paterno en LAST_NAME: Bitrix no tiene un campo para el segundo
 * apellido —SECOND_NAME es "segundo nombre", que es otra cosa— y meterlo ahí deja un dato donde
 * nadie lo va a buscar.
 */
export async function registrarDatosMatricula(
  datos: DatosMatricula,
  entities: CrmEntities,
  auth: Auth,
  opts: { tieneFotoCedula?: boolean } = {},
): Promise<ResultadoMatricula> {
  const contactId = entities.contact ?? null;
  if (!contactId) {
    return {
      ok: false,
      guardados: [],
      faltan: CLAVES.map((k) => ETIQUETAS[k]),
      completo: false,
      nota: 'Todavía no tengo su ficha lista para guardar los antecedentes. Sigue conversando y vuelve a intentarlo cuando registres su nombre y correo con registrar_interes_crm.',
    };
  }

  const fields: Record<string, unknown> = {};
  const guardados: string[] = [];
  const invalidos: string[] = [];
  // Claves REALMENTE escritas. No alcanza con que vinieran con texto: una fecha que no se pudo
  // interpretar no quedo guardada, y darla por entregada la dejaria vacia para siempre.
  const escritas = new Set<keyof DatosMatricula>();

  const apellidos = [limpio(datos.apellidoPaterno), limpio(datos.apellidoMaterno)].filter(Boolean).join(' ');
  if (limpio(datos.nombres)) { fields.NAME = limpio(datos.nombres); guardados.push(ETIQUETAS.nombres); escritas.add('nombres'); }
  if (apellidos) {
    fields.LAST_NAME = apellidos;
    if (limpio(datos.apellidoPaterno)) { guardados.push(ETIQUETAS.apellidoPaterno); escritas.add('apellidoPaterno'); }
    if (limpio(datos.apellidoMaterno)) { guardados.push(ETIQUETAS.apellidoMaterno); escritas.add('apellidoMaterno'); }
  }
  if (limpio(datos.domicilio)) { fields.ADDRESS = limpio(datos.domicilio); guardados.push(ETIQUETAS.domicilio); escritas.add('domicilio'); }
  if (limpio(datos.codigoPostal)) { fields.ADDRESS_POSTAL_CODE = limpio(datos.codigoPostal); guardados.push(ETIQUETAS.codigoPostal); escritas.add('codigoPostal'); }
  if (limpio(datos.celular)) {
    fields.PHONE = [{ VALUE: limpio(datos.celular), VALUE_TYPE: 'MOBILE' }];
    guardados.push(ETIQUETAS.celular);
    escritas.add('celular');
  }
  if (limpio(datos.emailPersonal)) {
    fields.EMAIL = [{ VALUE: limpio(datos.emailPersonal), VALUE_TYPE: 'HOME' }];
    guardados.push(ETIQUETAS.emailPersonal);
    escritas.add('emailPersonal');
  }
  if (limpio(datos.fechaNacimiento)) {
    const f = fechaBitrix(datos.fechaNacimiento!);
    if (f) { fields.BIRTHDATE = f; guardados.push(ETIQUETAS.fechaNacimiento); escritas.add('fechaNacimiento'); }
    else invalidos.push(ETIQUETAS.fechaNacimiento);
  }
  if (limpio(datos.anioTitulo)) {
    const a = anioDe(datos.anioTitulo!);
    // El campo del portal es de tipo fecha: se guarda el 31 de diciembre de ese año.
    if (a && config.ufAnioTitulo) { fields[config.ufAnioTitulo] = `${a}-12-31`; guardados.push(ETIQUETAS.anioTitulo); escritas.add('anioTitulo'); }
    else if (!a) invalidos.push(ETIQUETAS.anioTitulo);
  }
  if (limpio(datos.nacionalidad)) {
    const id = await idNacionalidad(datos.nacionalidad!, auth);
    if (id) { fields[config.ufNacionalidad] = id; guardados.push(ETIQUETAS.nacionalidad); escritas.add('nacionalidad'); }
  }
  for (const [clave, campo] of [
    ['dni', config.ufDni],
    ['tituloGrado', config.ufTituloGrado],
    ['institucionTitulo', config.ufInstitucionTitulo],
  ] as const) {
    const v = limpio(datos[clave]);
    if (v && campo) { fields[campo] = v; guardados.push(ETIQUETAS[clave]); escritas.add(clave); }
  }

  if (Object.keys(fields).length) {
    try {
      await callCrm('crm.contact.update', { id: contactId, fields }, auth);
      log.info('ficha de matrícula actualizada', { contactId, campos: Object.keys(fields).length });
    } catch (e) {
      log.warn('no se pudo guardar la ficha de matrícula', { err: String(e), contactId });
      return {
        ok: false,
        guardados: [],
        faltan: CLAVES.map((k) => ETIQUETAS[k]),
        completo: false,
        nota: 'No pude guardar sus antecedentes en este momento. No se lo digas como un error técnico: dile que lo estás registrando y sigue la conversación; se reintenta cuando entregue el próximo dato.',
      };
    }
  }

  // Lo que falta se calcula sobre lo que vino en ESTA llamada y lo que ya estaba en la ficha, para no
  // volver a pedir algo que la persona ya entregó en un mensaje anterior.
  const yaEnFicha = await leerLoQueYaEsta(contactId, auth);
  const faltan: string[] = [];
  for (const k of CLAVES) {
    if (escritas.has(k) || yaEnFicha.has(k)) continue;
    faltan.push(ETIQUETAS[k]);
  }
  if (!opts.tieneFotoCedula) faltan.push(ETIQUETAS.fotoCedula);
  const completo = faltan.length === 0;

  return {
    ok: true,
    guardados,
    faltan,
    completo,
    nota: completo
      ? 'La ficha quedó completa. Confírmaselo con calidez y pásale las instrucciones de pago con obtener_enlace_de_pago.'
      : invalidos.length
        ? `Guardé lo que pude. No entendí ${invalidos.join(' ni ')}: pídeselo de nuevo con un ejemplo de formato. Y pídele lo que falta, de a tres o cuatro datos por mensaje.`
        : 'Guardé lo que entregó. Pídele lo que falta, de a tres o cuatro datos por mensaje, sin repetir lo que ya tienes.',
  };
}

/** Qué antecedentes ya están en la ficha, para no volver a pedirlos. */
async function leerLoQueYaEsta(contactId: number, auth: Auth): Promise<Set<keyof DatosMatricula>> {
  const tiene = new Set<keyof DatosMatricula>();
  try {
    const select = ['NAME', 'LAST_NAME', 'ADDRESS', 'ADDRESS_POSTAL_CODE', 'BIRTHDATE', 'PHONE', 'EMAIL'];
    for (const c of [config.ufDni, config.ufNacionalidad, config.ufTituloGrado, config.ufInstitucionTitulo, config.ufAnioTitulo]) {
      if (c) select.push(c);
    }
    const c: any = await callCrm('crm.contact.get', { id: contactId, select }, auth);
    const lleno = (v: unknown) => (Array.isArray(v) ? v.length > 0 : limpio(v) !== '');
    if (lleno(c?.NAME)) tiene.add('nombres');
    // LAST_NAME lleva los dos apellidos juntos: con dos palabras se dan ambos por entregados.
    const ape = limpio(c?.LAST_NAME);
    if (ape) {
      tiene.add('apellidoPaterno');
      if (ape.split(/\s+/).length > 1) tiene.add('apellidoMaterno');
    }
    if (lleno(c?.ADDRESS)) tiene.add('domicilio');
    if (lleno(c?.ADDRESS_POSTAL_CODE)) tiene.add('codigoPostal');
    if (lleno(c?.BIRTHDATE)) tiene.add('fechaNacimiento');
    if (lleno(c?.PHONE)) tiene.add('celular');
    if (lleno(c?.EMAIL)) tiene.add('emailPersonal');
    if (config.ufDni && lleno(c?.[config.ufDni])) tiene.add('dni');
    if (config.ufNacionalidad && lleno(c?.[config.ufNacionalidad])) tiene.add('nacionalidad');
    if (config.ufTituloGrado && lleno(c?.[config.ufTituloGrado])) tiene.add('tituloGrado');
    if (config.ufInstitucionTitulo && lleno(c?.[config.ufInstitucionTitulo])) tiene.add('institucionTitulo');
    if (config.ufAnioTitulo && lleno(c?.[config.ufAnioTitulo])) tiene.add('anioTitulo');
  } catch (e) {
    // Sin la ficha no se sabe qué hay: se pide todo de nuevo antes que dar por entregado algo que no está.
    log.warn('no se pudo releer la ficha de matrícula', { err: String(e), contactId });
  }
  return tiene;
}

/**
 * Mueve la negociación a "Pendiente de Firma". Solo con la ficha completa.
 *
 * La etapa tiene un identificador distinto en cada embudo —C73:EXECUTING en Carver, C135:1 en
 * Carver CU— y en el 135 ese mismo C135:EXECUTING es "Info Urgente", así que escribir una etapa
 * fija mandaría a media matrícula al embudo equivocado.
 */
export async function moverAPendienteDeFirma(dealId: number, auth: Auth): Promise<boolean> {
  if (!dealId || !Object.keys(config.stagePendienteFirma).length) return false;
  try {
    const d: any = await callCrm('crm.deal.get', { id: dealId, select: ['CATEGORY_ID', 'STAGE_ID', 'CLOSED'] }, auth);
    const destino = config.stagePendienteFirma[Number(d?.CATEGORY_ID ?? -1)];
    if (!destino) return false;
    const actual = String(d?.STAGE_ID ?? '');
    if (actual === destino) return false;
    // Una negociación ya cerrada —matriculada o perdida— no se reabre desde el chat.
    if (d?.CLOSED === 'Y' || /:(WON|LOSE)$/.test(actual)) {
      log.info('no se mueve a Pendiente de Firma: la negociación ya está cerrada', { dealId, actual });
      return false;
    }
    await callCrm('crm.deal.update', { id: dealId, fields: { STAGE_ID: destino } }, auth);
    await audit({ type: 'derivacion', crmEntity: `deal#${dealId}`, detail: { decision: 'pendiente_de_firma', de: actual, a: destino } });
    log.info('negociación movida a Pendiente de Firma', { dealId, de: actual, a: destino });
    return true;
  } catch (e) {
    log.warn('moverAPendienteDeFirma falló', { err: String(e), dealId });
    return false;
  }
}
