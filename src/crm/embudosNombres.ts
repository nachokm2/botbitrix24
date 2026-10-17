import { callCrm } from '../bitrix/client';
import type { Auth } from '../store';
import { log } from '../log';

/**
 * Nombre de cada embudo (categoría de negociación), leído del propio Bitrix.
 *
 * El panel mostraba "Embudo 73" y, peor, agrupaba los embudos de otra marca en una fila que decía
 * "revisar" sin decir QUÉ revisar. Con 45 embudos en el portal, un número suelto no se puede
 * interpretar: no distingue una conversación de Postgrados que se coló de un embudo de Carver que
 * sencillamente no está declarado en BITRIX_EMBUDOS_PROPIOS. Son dos problemas opuestos —uno se
 * arregla en el bot, el otro en la configuración— y hasta ahora se veían idénticos.
 *
 * Los nombres se cachean: cambian como mucho un par de veces al año, y esto se consulta en cada
 * carga del panel.
 */

// Se lee en cada llamada y no al cargar el módulo: así una prueba puede vencer el caché a propósito
// para ejercitar el camino de error, que es justamente el que no se puede dejar sin cubrir.
const cacheMs = () => Number(process.env.EMBUDOS_NOMBRES_TTL_MS ?? 6 * 60 * 60 * 1000);
let cache: { t: number; nombres: Map<number, string> } | null = null;

export async function nombresDeEmbudos(auth: Auth): Promise<Map<number, string>> {
  if (cache && Date.now() - cache.t < cacheMs()) return cache.nombres;
  try {
    const rows = await callCrm<any>('crm.dealcategory.list', { order: { SORT: 'ASC' }, select: ['ID', 'NAME'] }, auth);
    const lista: any[] = Array.isArray(rows) ? rows : (rows?.result ?? []);
    const nombres = new Map<number, string>();
    // El 0 nunca viene en la lista: es el embudo "General" que Bitrix trae de fábrica.
    nombres.set(0, 'General');
    for (const r of lista) {
      const id = Number(r?.ID);
      const nombre = String(r?.NAME ?? '').trim();
      if (Number.isFinite(id) && nombre) nombres.set(id, nombre);
    }
    cache = { t: Date.now(), nombres };
    return nombres;
  } catch (e) {
    // Un panel sin nombres sigue siendo legible (cae a "Embudo N"); uno que no carga, no. Si había
    // nombres de antes se devuelven aunque estén vencidos: viejos siguen siendo correctos.
    log.warn('nombresDeEmbudos: crm.dealcategory.list falló', { err: String(e) });
    return cache?.nombres ?? new Map();
  }
}
