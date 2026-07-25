import type { Request, Response } from 'express';
import { getProgram } from '../campaign/programRegistry';
import { enrolarPrograma } from '../campaign/orchestrator';
import { dbCampaignCounts, dbCampaignDashboard } from '../store/db';
import { getState, EMPTY_AUTH } from '../store';
import { log } from '../log';

// Rutas admin de la campaña de voz saliente (montadas bajo requireAdminToken en index.ts).

/** POST /campaign/enroll?program=MMD — enrola los deals del embudo del programa en la campaña. */
export async function campaignEnroll(req: Request, res: Response) {
  const code = String((req.query.program as string) ?? (req.body as any)?.program ?? 'MMD');
  const pc = getProgram(code);
  if (!pc) return res.status(400).json({ ok: false, error: `programa desconocido: ${code}` });
  const st = await getState();
  const auth = st.auth ?? EMPTY_AUTH;
  try {
    const r = await enrolarPrograma(pc, auth);
    return res.json({ ok: true, program: pc.code, activo: pc.activo, ...r });
  } catch (e) {
    log.error('campaignEnroll error', { err: String(e) });
    return res.status(502).json({ ok: false, error: String(e) });
  }
}

/** GET /campaign/status?program=MMD — conteo de targets por estado (para monitoreo). */
export async function campaignStatus(req: Request, res: Response) {
  const code = String((req.query.program as string) ?? 'MMD');
  const pc = getProgram(code);
  if (!pc) return res.status(400).json({ ok: false, error: `programa desconocido: ${code}` });
  const counts = await dbCampaignCounts(pc.code);
  return res.json({
    ok: true,
    program: pc.code,
    nombre: pc.nombre,
    activo: pc.activo,
    categoryId: pc.bitrix.categoryId,
    agenda: { waves: pc.agenda.waves, maxPorDia: pc.agenda.maxPorDia, maxDias: pc.agenda.maxDias, maxTotal: pc.agenda.maxTotal, tz: pc.agenda.tz },
    counts,
  });
}

/** GET /campaign/data?program=MMD — datos del dashboard (KPIs + distribuciones + últimos intentos). */
export async function campaignData(req: Request, res: Response) {
  const code = String((req.query.program as string) ?? 'MMD');
  const pc = getProgram(code);
  if (!pc) return res.status(400).json({ ok: false, error: `programa desconocido: ${code}` });
  const data = await dbCampaignDashboard(pc.code);
  return res.json({
    ok: true,
    program: pc.code,
    nombre: pc.nombre,
    activo: pc.activo,
    agenda: { waves: pc.agenda.waves, maxPorDia: pc.agenda.maxPorDia, maxDias: pc.agenda.maxDias, maxTotal: pc.agenda.maxTotal, tz: pc.agenda.tz },
    data,
  });
}

/** GET /campaign/dashboard?program=MMD — panel operativo (HTML autocontenido). */
export function campaignDashboard(_req: Request, res: Response) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(DASHBOARD_HTML);
}

const DASHBOARD_HTML = `<!doctype html><html lang="es"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Campaña de Voz — Panel</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--tx:#1c2430;--mut:#6b7684;--bd:#e5e8ec;--ac:#2f6fed;--ok:#1a9d5a;--warn:#c9820a;--bad:#d1435b;--bar:#dfe6f5}
@media(prefers-color-scheme:dark){:root{--bg:#0f1420;--card:#161d2b;--tx:#e7ecf3;--mut:#95a1b2;--bd:#242e40;--ac:#5b8cff;--bar:#20304f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.45 system-ui,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:20px}
h1{font-size:19px;margin:0 0 2px}.sub{color:var(--mut);font-size:13px;margin-bottom:16px}
.badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600}
.on{background:rgba(26,157,90,.15);color:var(--ok)}.off{background:rgba(209,67,91,.15);color:var(--bad)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:18px}
.kpi{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:14px}
.kpi .n{font-size:24px;font-weight:700}.kpi .l{color:var(--mut);font-size:12px;margin-top:2px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:16px;margin-bottom:16px}
.card h2{font-size:14px;margin:0 0 12px;color:var(--mut);text-transform:uppercase;letter-spacing:.03em}
.row{display:flex;align-items:center;gap:10px;margin:6px 0}
.row .k{width:150px;font-size:13px;flex:none}.row .v{width:44px;text-align:right;font-variant-numeric:tabular-nums;flex:none}
.track{flex:1;background:var(--bar);border-radius:6px;height:10px;overflow:hidden}.fill{height:100%;background:var(--ac)}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--bd)}
th{color:var(--mut);font-weight:600}.mut{color:var(--mut)}.right{text-align:right}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:720px){.cols{grid-template-columns:1fr}}
.err{color:var(--bad)}
</style></head><body><div class="wrap">
<h1 id="title">Campaña de Voz</h1>
<div class="sub" id="sub">Cargando…</div>
<div class="grid" id="kpis"></div>
<div class="cols">
  <div class="card"><h2>Estado de la cola</h2><div id="estados"></div></div>
  <div class="card"><h2>Clasificación de cierres</h2><div id="clasif"></div></div>
</div>
<div class="cols">
  <div class="card"><h2>Resultado de intentos</h2><div id="outcomes"></div></div>
  <div class="card"><h2>Escalados por asesor</h2><div id="asesores"></div></div>
</div>
<div class="card"><h2>Últimos intentos</h2><div id="recientes"></div></div>
<div class="sub" id="foot"></div>
</div>
<script>
const qs=new URLSearchParams(location.search);const k=qs.get('k')||'';const prog=qs.get('program')||'MMD';
const EST={PENDING:'En cola',LLAMANDO:'Llamando',EN_CONVERSACION:'En conversación',CALIFICADO:'Calificado',ESCALADO:'Escalado',SEGUIMIENTO:'Seguimiento',CALLBACK:'Callback',NO_TITULAR:'No es titular',SIN_RESPUESTA:'Sin respuesta',NO_INTERESADO:'No interesado',NUMERO_INVALIDO:'Número inválido',AGOTADO:'Agotado',RECUPERACION:'Recuperación'};
const esc=s=>String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
function bars(el,obj,labels){const e=document.getElementById(el);const ent=Object.entries(obj||{});if(!ent.length){e.innerHTML='<div class="mut">Sin datos.</div>';return;}const max=Math.max(...ent.map(x=>x[1]),1);e.innerHTML=ent.sort((a,b)=>b[1]-a[1]).map(([k,v])=>'<div class="row"><div class="k">'+esc((labels&&labels[k])||k)+'</div><div class="track"><div class="fill" style="width:'+Math.round(v/max*100)+'%"></div></div><div class="v">'+v+'</div></div>').join('');}
function kpi(n,l){return '<div class="kpi"><div class="n">'+n+'</div><div class="l">'+l+'</div></div>';}
async function load(){try{
 const r=await fetch('/campaign/data?program='+encodeURIComponent(prog)+'&k='+encodeURIComponent(k));
 const j=await r.json();if(!j.ok)throw new Error(j.error||'error');
 document.getElementById('title').textContent='Campaña de Voz — '+esc(j.nombre||prog);
 const a=j.agenda||{};document.getElementById('sub').innerHTML=(j.activo?'<span class="badge on">ACTIVA</span>':'<span class="badge off">INACTIVA</span>')+' &nbsp; Olas: '+esc((a.waves||[]).join(', '))+' · '+a.maxPorDia+'/día × '+a.maxDias+' días · '+esc(a.tz||'');
 const d=j.data;
 if(!d){document.getElementById('kpis').innerHTML='<div class="kpi"><div class="n mut">—</div><div class="l">Sin Postgres o sin datos aún</div></div>';['estados','clasif','outcomes','asesores','recientes'].forEach(x=>document.getElementById(x).innerHTML='<div class="mut">—</div>');document.getElementById('foot').textContent='Actualizado '+new Date().toLocaleTimeString();return;}
 const K=d.kpis||{},T=d.targets||{},A=d.attempts||{};
 document.getElementById('kpis').innerHTML=[kpi(T.total||0,'En campaña'),kpi((K.tasaContacto||0)+'%','Tasa de contacto'),kpi(K.escalados||0,'Escalados ('+(K.tasaEscalamiento||0)+'%)'),kpi(K.noInteresados||0,'No interesados'),kpi(K.agotados||0,'Agotados'),kpi(K.recuperacion||0,'Recuperación'),kpi(A.hoy||0,'Intentos hoy'),kpi(T.scoreProm==null?'—':T.scoreProm,'Score prom.')].join('');
 bars('estados',T.byStatus,EST);bars('clasif',d.clasificaciones);bars('outcomes',A.byOutcome);
 const as=(d.porAsesor||[]);document.getElementById('asesores').innerHTML=as.length?('<table><tr><th>Asesor (ID)</th><th class="right">Escalados</th></tr>'+as.map(x=>'<tr><td>'+esc(x.id)+'</td><td class="right">'+x.c+'</td></tr>').join('')+'</table>'):'<div class="mut">Sin escalamientos aún.</div>';
 const rc=(d.recientes||[]);document.getElementById('recientes').innerHTML=rc.length?('<table><tr><th>Deal</th><th>#</th><th>Resultado</th><th>Clasificación</th><th class="right">Score</th><th>Fecha</th></tr>'+rc.map(x=>'<tr><td>'+esc(x.deal_id)+'</td><td>'+esc(x.attempt_no)+'</td><td>'+esc(x.outcome_code||'—')+'</td><td>'+esc(x.classification||'—')+'</td><td class="right">'+(x.lead_score==null?'—':x.lead_score)+'</td><td class="mut">'+esc(x.ts||'')+'</td></tr>').join('')+'</table>'):'<div class="mut">Sin intentos registrados.</div>';
 document.getElementById('foot').textContent='Actualizado '+new Date().toLocaleTimeString()+' · se refresca cada 20s';
}catch(e){document.getElementById('sub').innerHTML='<span class="err">Error: '+esc(e.message)+'</span>';}}
load();setInterval(load,20000);
</script></body></html>`;
