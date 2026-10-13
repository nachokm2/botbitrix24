/**
 * Devuelve a su asesor anterior las negociaciones que el punto de entrada único acumuló.
 *
 *   npm run reasignar                                  → SIMULACIÓN, solo las inequívocas
 *   npm run reasignar -- --ejecutar                    → escribe en el CRM
 *   npm run reasignar -- --criterio=ultimo --ejecutar  → incluye las ambiguas, al último que la tocó
 *
 * Contexto: con BITRIX_DERIVAR_A configurado, el bot reasigna a esa persona toda negociación que
 * toca. En Carver eso dejó 165 negociaciones en manos de una sola, quitándoselas a los asesores que
 * las tenían.
 *
 * Bitrix NO expone por REST el historial de responsable —lo verifiqué: crm.item.history.list no
 * existe, el timeline de sistema viene vacío y el creador es el robot de automatización—, así que
 * el asesor anterior se deduce de QUIÉN ERA RESPONSABLE DE LA ACTIVIDAD MÁS ANTIGUA de cada
 * negociación. Es un indicio sólido, no un registro.
 *
 * Por eso solo se tocan las INEQUÍVOCAS: las que tuvieron un único responsable humano. Donde hubo
 * varios, elegir sería adivinar, y equivocarse le entrega el lead a quien no corresponde.
 *
 * Antes de escribir deja un archivo de reversa con el estado previo de cada negociación.
 */
import { callCrm } from '../src/bitrix/client';
import { getUsuarios } from '../src/crm/directory';
import { getState } from '../src/store';
import { config } from '../src/config';
import { writeFileSync } from 'node:fs';

const LOTE = 50;

async function main() {
  const ejecutar = process.argv.includes('--ejecutar');
  // Criterio para las negociaciones con VARIOS responsables humanos:
  //   (sin bandera)        se dejan fuera — elegir sería adivinar
  //   --criterio=ultimo    van al humano de la actividad más reciente
  // Se midió antes de ofrecerlo: de 65 ambiguas, solo 3 tenían un responsable a la vez dominante y
  // último, así que ningún criterio automático "acierta solo". Éste es una decisión de negocio
  // —quien la tocó al final es quien la tiene fresca—, no una deducción.
  const criterioUltimo = process.argv.includes('--criterio=ultimo');
  // Días sin trabajar NINGUNA negociación tras los cuales alguien deja de ser destino válido.
  // Estar "activo" en Bitrix no basta: apareció una asesora marcada como activa cuya última
  // actividad era de hacía 70 días, y se habría llevado 38 negociaciones a un buzón donde nadie
  // mira. 0 = sin filtro.
  const maxDiasArg = process.argv.find((a) => a.startsWith('--max-dias-inactivo='));
  const maxDiasInactivo = maxDiasArg ? Number(maxDiasArg.split('=')[1]) || 0 : 0;
  const destino = config.derivarATodo;
  const categorias = config.embudosPropios;
  if (!destino) return fallar('BITRIX_DERIVAR_A no está configurado: no hay punto de entrada que revertir.');
  if (!categorias.length) return fallar('BITRIX_EMBUDOS_PROPIOS vacío: definir en qué embudos operar antes de tocar nada.');

  const st = await getState();
  if (!st.auth) return fallar('Sin auth de Bitrix.');
  const auth = st.auth;

  // Quiénes NO cuentan como "asesor anterior": el propio punto de entrada, las automatizaciones y
  // el bot (sus actividades son las que creó al conversar, no las de un asesor trabajando el caso).
  const excluir = new Set<number>([destino, 0, ...config.usuariosAutomaticos]);
  if (config.botId) excluir.add(Number(config.botId));

  const deals: any[] = [];
  for (let start = 0; start < 2000; start += LOTE) {
    const p: any = await callCrm(
      'crm.deal.list',
      {
        filter: { '@CATEGORY_ID': categorias, ASSIGNED_BY_ID: destino },
        select: ['ID', 'CATEGORY_ID', 'TITLE', 'STAGE_ID'],
        order: { ID: 'ASC' },
        start,
      },
      auth,
    );
    const arr = Array.isArray(p) ? p : [];
    if (!arr.length) break;
    deals.push(...arr);
    if (arr.length < LOTE) break;
  }
  if (!deals.length) return console.log('No hay negociaciones del punto de entrada en esos embudos.');

  // Actividades en lote: @OWNER_ID acepta arrays, así que no hace falta una llamada por negociación.
  const porDeal = new Map<number, number[]>();
  const ids = deals.map((d) => Number(d.ID));
  for (let i = 0; i < ids.length; i += LOTE) {
    const lote = ids.slice(i, i + LOTE);
    for (let start = 0; start < 2000; start += LOTE) {
      const p: any = await callCrm(
        'crm.activity.list',
        { filter: { OWNER_TYPE_ID: 2, '@OWNER_ID': lote }, select: ['OWNER_ID', 'RESPONSIBLE_ID'], order: { CREATED: 'ASC' }, start },
        auth,
      );
      const arr = Array.isArray(p) ? p : [];
      if (!arr.length) break;
      for (const a of arr) {
        const k = Number(a.OWNER_ID);
        const r = Number(a.RESPONSIBLE_ID);
        if (excluir.has(r)) continue;
        if (!porDeal.has(k)) porDeal.set(k, []);
        porDeal.get(k)!.push(r);
      }
      if (arr.length < LOTE) break;
    }
  }

  // Quién sigue trabajando ahí. Un asesor dado de baja no puede recibir nada: la negociación caería
  // en un buzón muerto, peor que dejarla donde está. Caso real: el criterio "último que la tocó"
  // mandaba 46 de 67 a una persona que ya no está en la empresa desde septiembre.
  const candidatos = [...new Set([...porDeal.values()].flat())];
  const inactivos = new Set<number>();
  for (let i = 0; i < candidatos.length; i += LOTE) {
    try {
      for (const u of await getUsuarios(candidatos.slice(i, i + LOTE), auth)) {
        if (u.activo === false) inactivos.add(u.id);
      }
    } catch {
      /* sin poder comprobarlo se sigue: el riesgo es menor que no reasignar nada */
    }
  }
  if (inactivos.size) console.log(`  (${inactivos.size} asesores dados de baja quedan fuera como destino)`);

  // Y los que siguen de alta pero hace mucho no trabajan una negociación.
  if (maxDiasInactivo > 0) {
    const dormidos: string[] = [];
    for (const id of candidatos) {
      if (inactivos.has(id)) continue;
      try {
        const r: any = await callCrm(
          'crm.activity.list',
          { filter: { OWNER_TYPE_ID: 2, RESPONSIBLE_ID: id }, select: ['CREATED'], order: { CREATED: 'DESC' }, start: 0 },
          auth,
        );
        const ultima = (Array.isArray(r) ? r : [])[0]?.CREATED;
        const dias = ultima ? Math.round((Date.now() - new Date(ultima).getTime()) / 86400_000) : 9999;
        if (dias > maxDiasInactivo) {
          inactivos.add(id);
          dormidos.push(`#${id} (${dias} días)`);
        }
      } catch {
        /* si no se puede comprobar, se deja pasar: no inventar una baja */
      }
    }
    if (dormidos.length) console.log(`  (sin actividad hace más de ${maxDiasInactivo} días, quedan fuera: ${dormidos.join(', ')})`);
  }

  const inequivocas: Array<{ dealId: number; asesor: number; titulo: string; stage: string; ambigua?: boolean }> = [];
  const ambiguas: number[] = [];
  const huerfanas: number[] = [];
  for (const d of deals) {
    const resp = (porDeal.get(Number(d.ID)) ?? []).filter((r) => !inactivos.has(r)); // cronológico
    const distintos = [...new Set(resp)];
    const base = { dealId: Number(d.ID), titulo: String(d.TITLE ?? '').slice(0, 50), stage: String(d.STAGE_ID ?? '') };
    if (!distintos.length) huerfanas.push(Number(d.ID));
    else if (distintos.length === 1) inequivocas.push({ ...base, asesor: distintos[0] });
    else if (criterioUltimo) inequivocas.push({ ...base, asesor: resp[resp.length - 1], ambigua: true });
    else ambiguas.push(Number(d.ID));
  }

  const nombres = new Map<number, string>();
  const idsAsesor = [...new Set(inequivocas.map((f) => f.asesor))];
  for (let i = 0; i < idsAsesor.length; i += LOTE) {
    try {
      for (const u of await getUsuarios(idsAsesor.slice(i, i + LOTE), auth)) nombres.set(u.id, u.nombre);
    } catch {
      /* sin nombres se opera igual: lo que importa es el id */
    }
  }

  console.log(`\nEmbudos ${categorias.join(', ')} · punto de entrada #${destino}`);
  console.log(`  total en su poder:        ${deals.length}`);
  const porUltimo = inequivocas.filter((f) => f.ambigua).length;
  console.log(`  se tocan:                 ${inequivocas.length}${porUltimo ? ` (${inequivocas.length - porUltimo} con un único responsable + ${porUltimo} por "último que la tocó")` : ''}`);
  console.log(`  ambiguas (NO se tocan):   ${ambiguas.length}`);
  console.log(`  sin asesor previo:        ${huerfanas.length}\n`);

  const porAsesor = new Map<number, number>();
  for (const f of inequivocas) porAsesor.set(f.asesor, (porAsesor.get(f.asesor) ?? 0) + 1);
  for (const [id, n] of [...porAsesor.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)} → ${nombres.get(id) ?? '?'} (#${id})`);
  }

  if (!ejecutar) {
    console.log('\nSIMULACIÓN: no se escribió nada. Repite con --ejecutar para aplicarlo.');
    return;
  }

  // Reversa ANTES de escribir: sin esto, deshacer la operación exigiría repetir toda la deducción.
  const reversa = inequivocas.map((f) => ({ dealId: f.dealId, antes: destino, despues: f.asesor }));
  const archivo = `reversa-reasignacion-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`;
  writeFileSync(archivo, JSON.stringify(reversa, null, 2));
  console.log(`\nReversa guardada en ${archivo}`);

  let ok = 0;
  const fallos: Array<{ dealId: number; err: string }> = [];
  for (const f of inequivocas) {
    try {
      // Se relee justo antes: si alguien la movió mientras corríamos, no se pisa su decisión.
      const d: any = await callCrm('crm.deal.get', { id: f.dealId, select: ['ASSIGNED_BY_ID'] }, auth);
      if (Number(d?.ASSIGNED_BY_ID ?? 0) !== destino) {
        fallos.push({ dealId: f.dealId, err: 'cambió de responsable mientras corría; se deja como está' });
        continue;
      }
      await callCrm('crm.deal.update', { id: f.dealId, fields: { ASSIGNED_BY_ID: f.asesor } }, auth);
      ok++;
      if (ok % 20 === 0) console.log(`  ...${ok}/${inequivocas.length}`);
    } catch (e) {
      fallos.push({ dealId: f.dealId, err: String(e).slice(0, 120) });
    }
  }

  console.log(`\nReasignadas: ${ok} de ${inequivocas.length}`);
  if (fallos.length) {
    console.log(`No se pudieron (${fallos.length}):`);
    for (const f of fallos.slice(0, 10)) console.log(`  deal#${f.dealId}  ${f.err}`);
  }
  console.log(`\nSin tocar: ${ambiguas.length} ambiguas y ${huerfanas.length} sin asesor previo.`);
}

function fallar(mensaje: string) {
  console.error(mensaje);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
