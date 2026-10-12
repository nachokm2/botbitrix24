import { callCrm } from '../bitrix/client';
import { aE164, paisPermitido } from './primerContacto';
import { config } from '../config';
import type { Auth } from '../store';
import { log } from '../log';

/**
 * Calidad de los datos del CRM, medida sobre lo que acaba de entrar.
 *
 * Antes esto daba un poco lo mismo: un teléfono mal cargado solo significaba que un asesor no podía
 * llamar. Ahora cada registro defectuoso cuesta dinero —se paga por mensaje enviado— y ensucia la
 * medición de la campaña. En la primera muestra de Carver aparecieron 3 de cada 200 con el país
 * equivocado; uno era un chileno al que le faltaba el 56 y el mensaje habría salido a Sri Lanka.
 *
 * Es solo lectura: informa, no corrige. Arreglar datos del CRM a ciegas es peor que convivir con
 * ellos — hay que mirarlos caso a caso.
 */

const LOTE = 50;

export type ProblemaDato = 'sin_contacto' | 'sin_telefono' | 'telefono_invalido' | 'pais_no_atendido' | 'sin_nombre' | 'sin_programa';

export type InformeCalidad = {
  analizadas: number;
  personas: number;
  problemas: Record<ProblemaDato, number>;
  ejemplos: Array<{ dealId: number; problema: ProblemaDato; valor: string }>;
};

export async function informeCalidadDatos(auth: Auth, dias = 7, limite = 300): Promise<InformeCalidad> {
  const desde = new Date(Date.now() - dias * 86400_000).toISOString().slice(0, 10);
  const filtro: Record<string, unknown> = { '>=DATE_CREATE': desde };
  if (config.primerContactoCategorias.length) filtro['@CATEGORY_ID'] = config.primerContactoCategorias;

  const out: InformeCalidad = {
    analizadas: 0,
    personas: 0,
    problemas: { sin_contacto: 0, sin_telefono: 0, telefono_invalido: 0, pais_no_atendido: 0, sin_nombre: 0, sin_programa: 0 },
    ejemplos: [],
  };
  const anota = (dealId: number, problema: ProblemaDato, valor = '') => {
    out.problemas[problema]++;
    if (out.ejemplos.filter((e) => e.problema === problema).length < 3) out.ejemplos.push({ dealId, problema, valor });
  };

  const deals: Array<Record<string, any>> = [];
  for (let start = 0; start < limite; start += LOTE) {
    try {
      const pagina = await callCrm<Array<Record<string, any>>>(
        'crm.deal.list',
        {
          filter: filtro,
          select: ['ID', 'CONTACT_ID', 'TITLE', ...(config.ufPrograma ? [config.ufPrograma] : [])],
          order: { DATE_CREATE: 'DESC' },
          start,
        },
        auth,
      );
      if (!Array.isArray(pagina) || !pagina.length) break;
      deals.push(...pagina);
      if (pagina.length < LOTE) break;
    } catch (e) {
      log.warn('informeCalidadDatos: crm.deal.list falló', { err: String(e) });
      break;
    }
  }
  out.analizadas = deals.length;
  if (!deals.length) return out;

  for (const d of deals) {
    if (config.ufPrograma && !String(d[config.ufPrograma] ?? '').trim()) anota(Number(d.ID), 'sin_programa', String(d.TITLE ?? '').slice(0, 50));
    if (!d.CONTACT_ID || d.CONTACT_ID === '0') anota(Number(d.ID), 'sin_contacto');
  }

  const ids = [...new Set(deals.map((d) => Number(d.CONTACT_ID)).filter((n) => n > 0))];
  out.personas = ids.length;
  const dealDeContacto = new Map<number, number>();
  for (const d of deals) if (d.CONTACT_ID) dealDeContacto.set(Number(d.CONTACT_ID), Number(d.ID));

  for (let i = 0; i < ids.length; i += LOTE) {
    try {
      const filas = await callCrm<Array<Record<string, any>>>(
        'crm.contact.list',
        { filter: { '@ID': ids.slice(i, i + LOTE) }, select: ['ID', 'NAME', 'PHONE'] },
        auth,
      );
      for (const c of Array.isArray(filas) ? filas : []) {
        const dealId = dealDeContacto.get(Number(c.ID)) ?? 0;
        if (!String(c.NAME ?? '').trim()) anota(dealId, 'sin_nombre');
        const crudo = String(c.PHONE?.[0]?.VALUE ?? '').trim();
        if (!crudo) {
          anota(dealId, 'sin_telefono');
          continue;
        }
        const tel = aE164(crudo);
        if (!tel) anota(dealId, 'telefono_invalido', crudo.slice(0, 20));
        else if (!paisPermitido(tel)) anota(dealId, 'pais_no_atendido', tel.slice(0, 6) + '…');
      }
    } catch (e) {
      log.warn('informeCalidadDatos: crm.contact.list falló', { err: String(e) });
    }
  }
  return out;
}
