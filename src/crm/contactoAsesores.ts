import { config } from '../config';
import { log } from '../log';

/**
 * Datos de contacto de cada asesor que la coordinación entregó para dárselos a los clientes (Carver,
 * 02-11-2026): WhatsApp, correo institucional y formulario de postulación. También el cargo con que
 * se presenta («orientadora académica»): lo da la coordinación porque Bitrix no sirve para saber la
 * forma correcta de cada persona (su campo de género marca «M» hasta al bot).
 *
 * La ficha de usuario de Bitrix no sirve para esto en Carver. Los móviles están desactualizados (por
 * eso marca.telefonoAsesorVigente es false) y cinco de los siete asesores tienen su Gmail personal
 * como correo de la cuenta. Por la misma razón se busca por id de usuario y no por correo: el de
 * Bitrix casi nunca coincide con el institucional.
 *
 * Vive en la variable ASESORES_CONTACTO, no en el repositorio, que es público. Un dato que no pasa la
 * validación se descarta solo, sin arrastrar a los demás del mismo asesor: un número a medias es peor
 * que ninguno, porque la persona escribe, no le contesta nadie y concluye que la dejaron botada.
 */
export type ContactoAsesor = { whatsapp?: string; email?: string; formulario?: string; cargo?: string };

/** En formato internacional (+56912345678). Acepta espacios, guiones y paréntesis, y el número sin
 *  el "+" inicial, que es como suele venir copiado de una planilla. */
function whatsappValido(v: unknown): string | undefined {
  const limpio = String(v ?? '').replace(/[\s()\-.]/g, '');
  const conMas = /^\d{8,15}$/.test(limpio) ? `+${limpio}` : limpio;
  return /^\+[1-9]\d{7,14}$/.test(conMas) ? conMas : undefined;
}

/** Un correo bien formado y, si la marca declara dominio institucional, de ese dominio. */
function emailValido(v: unknown): string | undefined {
  const e = String(v ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return undefined;
  if (config.dominioCorreoOficial && !e.endsWith(`@${config.dominioCorreoOficial}`)) return undefined;
  return e;
}

function formularioValido(v: unknown): string | undefined {
  try {
    const u = new URL(String(v ?? '').trim());
    return u.protocol === 'https:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Va tal cual en el primer mensaje al cliente: solo letras y espacios, y de largo razonable. */
function cargoValido(v: unknown): string | undefined {
  const c = String(v ?? '').trim().replace(/\s+/g, ' ');
  return /^[\p{L} ]{3,60}$/u.test(c) ? c : undefined;
}

/** Lee la lista. Nunca lanza: una variable mal escrita deja al bot con la ficha de Bitrix, como antes.
 *  En el registro van solo el id y el campo rechazado, nunca el valor: son datos personales. */
export function leerContactoAsesores(texto: string): Map<number, ContactoAsesor> {
  const out = new Map<number, ContactoAsesor>();
  if (!texto.trim()) return out;
  let lista: unknown;
  try {
    lista = JSON.parse(texto);
  } catch {
    log.warn('ASESORES_CONTACTO no es un JSON válido: se ignora completa');
    return out;
  }
  if (!Array.isArray(lista)) {
    log.warn('ASESORES_CONTACTO debe ser una lista: se ignora completa');
    return out;
  }
  for (const crudo of lista) {
    const x = (crudo && typeof crudo === 'object' ? crudo : {}) as Record<string, unknown>;
    const id = Number(x.id);
    if (!Number.isInteger(id) || id <= 0) {
      log.warn('ASESORES_CONTACTO: fila sin id de usuario válido, se ignora');
      continue;
    }
    const c: ContactoAsesor = {};
    for (const [campo, validar] of [
      ['whatsapp', whatsappValido],
      ['email', emailValido],
      ['formulario', formularioValido],
      ['cargo', cargoValido],
    ] as const) {
      if (x[campo] === undefined || x[campo] === '') continue;
      const v = validar(x[campo]);
      if (v) c[campo] = v;
      else log.warn('ASESORES_CONTACTO: dato rechazado', { id, campo });
    }
    out.set(id, c);
  }
  return out;
}

let tabla: Map<number, ContactoAsesor> | null = null;

/** Lo que la coordinación entregó para este asesor, o un objeto vacío si no está en la lista. */
export function contactoDelAsesor(id: number): ContactoAsesor {
  tabla ??= leerContactoAsesores(config.asesoresContacto);
  return tabla.get(id) ?? {};
}
