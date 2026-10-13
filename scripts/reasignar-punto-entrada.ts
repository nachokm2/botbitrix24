/**
 * Devuelve a su asesor anterior las negociaciones que el punto de entrada único acumuló.
 *
 *   npm run reasignar                    → SIMULACIÓN: muestra qué haría, sin escribir
 *   npm run reasignar -- --ejecutar      → escribe en el CRM
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

  const inequivocas: Array<{ dealId: number; asesor: number; titulo: string; stage: string }> = [];
  const ambiguas: number[] = [];
  const huerfanas: number[] = [];
  for (const d of deals) {
    const resp = porDeal.get(Number(d.ID)) ?? [];
    const distintos = [...new Set(resp)];
    if (!distintos.length) huerfanas.push(Number(d.ID));
    else if (distintos.length > 1) ambiguas.push(Number(d.ID));
    else inequivocas.push({ dealId: Number(d.ID), asesor: distintos[0], titulo: String(d.TITLE ?? '').slice(0, 50), stage: String(d.STAGE_ID ?? '') });
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
  console.log(`  inequívocas (se tocan):   ${inequivocas.length}`);
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
