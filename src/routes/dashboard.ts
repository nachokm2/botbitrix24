import type { Request, Response } from 'express';
import { snapshot } from '../obs/metrics';
import { dbMetricsSummary, dbRecentAudit, dbEnabled } from '../store/db';
import { kvKind } from '../store/kv';
import { getState } from '../store';
import { getUsuarios } from '../crm/openlinesCrm';
import { config } from '../config';

const RANGES = ['today', '7d', '30d', 'all'];

/** JSON con métricas de negocio (persistentes) + técnicas (en memoria) + actividad reciente. */
export async function metricsSummary(req: Request, res: Response) {
  const range = RANGES.includes(String(req.query.range)) ? String(req.query.range) : '7d';
  const live = snapshot();
  const [agg, recent] = await Promise.all([dbMetricsSummary(range), dbRecentAudit(15)]);

  // Resuelve el nombre de cada asesor responsable (por su ASSIGNED_BY_ID) para el desglose "Por asesor".
  if (agg?.porAsesor?.length) {
    const st = await getState();
    if (st.auth) {
      try {
        const ids = agg.porAsesor.map((r: any) => Number(r.id)).filter((n: number) => n > 0);
        const usuarios = await getUsuarios(ids, st.auth);
        const byId = new Map(usuarios.map((u) => [u.id, u.nombre]));
        agg.porAsesor = agg.porAsesor.map((r: any) => ({ ...r, nombre: byId.get(Number(r.id)) ?? `Asesor ${r.id}` }));
      } catch {
        /* deja los IDs si no se pueden resolver nombres */
      }
    }
  }

  res.json({
    ok: true,
    range,
    kv: kvKind,
    db: dbEnabled() ? 'postgres' : 'off',
    startedAt: live.startedAt,
    live: { counters: live.counters, llm: live.llm },
    agg,
    recent,
    funnelLabels: config.funnelLabels,
  });
}

/** Página del panel (se embebe dentro de Bitrix24 vía placement, y también funciona standalone). */
export function dashboardPage(_req: Request, res: Response) {
  res.set('Content-Type', 'text/html; charset=utf-8').send(DASHBOARD_HTML);
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agente Postgrados — Panel</title>
<script src="//api.bitrix24.com/api/v1/"></script>
<style>
  :root{--bg:#f4f6f9;--card:#fff;--ink:#1a2734;--muted:#7a8794;--line:#e6ebf1;--brand:#2f6fed;--ok:#12b76a;--warn:#f79009;--bad:#f04438}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  .wrap{max-width:1100px;margin:0 auto;padding:20px}
  header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:16px}
  h1{font-size:20px;margin:0}.sub{color:var(--muted);font-size:12px}
  .pill{display:inline-block;padding:2px 8px;border-radius:999px;background:#eef3fe;color:var(--brand);font-size:12px;font-weight:600}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}
  .kpi .n{font-size:26px;font-weight:700;line-height:1.1}.kpi .l{color:var(--muted);font-size:12px;margin-top:4px}
  .sec{margin-top:20px}.sec h2{font-size:14px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin:0 0 10px}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:720px){.row{grid-template-columns:1fr}}
  .bar{display:flex;align-items:center;gap:8px;margin:6px 0}.bar .lab{width:120px;color:var(--muted);font-size:12px;text-align:right}
  .bar .track{flex:1;background:#eef1f5;border-radius:6px;height:14px;overflow:hidden}.bar .fill{height:100%;background:var(--brand);border-radius:6px}
  .bar .v{width:44px;font-weight:600;font-size:12px}
  table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:600}
  .tag{font-size:11px;padding:1px 6px;border-radius:6px;background:#eef1f5;color:#42526e}
  .muted{color:var(--muted)}.err{color:var(--bad)}
  footer{margin-top:18px;color:var(--muted);font-size:11px;text-align:center}
  .ranges{display:flex;gap:6px;margin-bottom:14px}
  .ranges button{border:1px solid var(--line);background:#fff;color:#42526e;border-radius:8px;padding:6px 12px;font:inherit;font-size:12px;cursor:pointer}
  .ranges button.on{background:var(--brand);border-color:var(--brand);color:#fff;font-weight:600}
  .days{display:flex;align-items:flex-end;gap:6px;height:90px}
  .days .d{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px}
  .days .col{width:100%;background:var(--brand);border-radius:4px 4px 0 0;min-height:2px}
  .days .dl{font-size:10px;color:var(--muted)}
</style></head>
<body><div class="wrap">
  <header>
    <div><h1>Agente de Postgrados — Panel</h1><div class="sub">Universidad Autónoma de Chile · métricas del asistente de IA</div></div>
    <div id="status"><span class="pill">cargando…</span></div>
  </header>

  <div class="ranges" id="ranges">
    <button data-r="today">Hoy</button>
    <button data-r="7d" class="on">7 días</button>
    <button data-r="30d">30 días</button>
    <button data-r="all">Todo</button>
  </div>

  <div class="grid" id="kpis"></div>

  <div class="sec row">
    <div class="card"><h2 style="margin-top:0">Por embudo</h2><div id="embudo"></div></div>
    <div class="card"><h2 style="margin-top:0">Por asesor responsable</h2><div id="asesores"></div></div>
  </div>

  <div class="sec"><h2>Mensajes por día (últimos 7)</h2><div class="card"><div class="days" id="days"></div></div></div>

  <div class="sec row">
    <div class="card"><h2 style="margin-top:0">Intención de los leads</h2><div id="intencion"></div></div>
    <div class="card"><h2 style="margin-top:0">Sentimiento</h2><div id="sentimiento"></div></div>
  </div>

  <div class="sec"><h2>Uso de herramientas</h2><div class="card"><div id="tools"></div></div></div>

  <div class="sec"><h2>Actividad reciente</h2><div class="card" style="overflow-x:auto">
    <table><thead><tr><th>Fecha</th><th>Evento</th><th>Diálogo</th><th>CRM</th></tr></thead><tbody id="recent"></tbody></table>
  </div></div>

  <footer id="foot"></footer>
</div>
<script>
  try { if (window.BX24) BX24.init(function(){ try{ BX24.fitWindow(); }catch(e){} }); } catch(e){}

  var LBL = {
    consultar_programas:'Consultas de programas', detalle_programa:'Detalle de programa',
    registrar_interes_crm:'Registro de datos (CRM)', escalar_a_humano:'Escalar a humano'
  };
  var esc = function(s){ return String(s==null?'':s).replace(/[&<>]/g, function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;'}[c];}); };
  var num = function(n){ return (n==null?0:n).toLocaleString('es-CL'); };

  function kpi(n,l){ return '<div class="card kpi"><div class="n">'+n+'</div><div class="l">'+l+'</div></div>'; }
  function barRow(lab,v,max,color){ var w=max>0?Math.round(v/max*100):0; return '<div class="bar"><div class="lab">'+esc(lab)+'</div><div class="track"><div class="fill" style="width:'+w+'%'+(color?';background:'+color:'')+'"></div></div><div class="v">'+num(v)+'</div></div>'; }
  function dist(obj, colors){ obj=obj||{}; var keys=Object.keys(obj); if(!keys.length) return '<div class="muted">Sin datos aún.</div>'; var max=Math.max.apply(null,keys.map(function(k){return obj[k];})); return keys.map(function(k){return barRow(k, obj[k], max, colors&&colors[k]);}).join(''); }

  function render(d){
    var live=d.live||{counters:{},llm:{}}, c=live.counters||{}, agg=d.agg;
    var pick=function(a,b){ return (a!=null)?a:(b||0); };
    var conversaciones = agg? agg.conversaciones : pick(c.conversations);
    var mensajes = agg? agg.turnos : pick(c.inbound);
    var leads = agg? agg.leadsCapturados : pick(c['tool:registrar_interes_crm']);
    var escal = agg? agg.escalamientos : (pick(c.auto_escalation)+pick(c['tool:escalar_a_humano']));
    var consultas = agg? (agg.tools&&agg.tools.consultar_programas||0) : pick(c['tool:consultar_programas']);
    var etapas = agg? agg.etapasMovidas : pick(c.stage_move);
    var scoreAvg = agg&&agg.scoreAvg!=null? agg.scoreAvg : '—';
    var errores = pick(c.errors);

    document.getElementById('kpis').innerHTML =
      kpi(num(conversaciones),'Conversaciones') + kpi(num(mensajes),'Mensajes') +
      kpi(num(leads),'Leads capturados') + kpi(num(escal),'Escalamientos a asesor') +
      kpi(num(consultas),'Consultas de programas') + kpi(num(etapas),'Etapas de deal movidas') +
      kpi(scoreAvg,'Score promedio') + kpi(num(errores),'Errores');

    // Por embudo
    var emb=(agg&&agg.porEmbudo)||[]; var labels=d.funnelLabels||{}; var embEl=document.getElementById('embudo');
    if(emb.length){ var emax=Math.max.apply(null,emb.map(function(x){return x.c;}))||1;
      embEl.innerHTML=emb.map(function(x){ var name=labels[x.cat]||('Embudo '+x.cat); var extra=(x.avg!=null)?(' · score prom '+x.avg):''; return barRow(name+extra, x.c, emax); }).join('');
    } else embEl.innerHTML='<span class="muted">Sin evaluaciones por embudo aún (se llena cuando el bot puntúe leads con deal).</span>';

    // Por asesor responsable
    var ases=(agg&&agg.porAsesor)||[]; var asEl=document.getElementById('asesores');
    if(ases.length){ var amax=Math.max.apply(null,ases.map(function(x){return x.convs||x.c;}))||1;
      asEl.innerHTML=ases.map(function(x){ var nm=x.nombre||('Asesor '+x.id); var extra=(x.avg!=null)?(' · score prom '+x.avg):''; return barRow(nm+extra, x.convs||x.c, amax); }).join('');
    } else asEl.innerHTML='<span class="muted">Sin datos por asesor aún (se llena cuando el bot puntúe leads con deal asignado).</span>';

    // Mensajes por día
    var days = (agg&&agg.porDia)||[]; var dEl=document.getElementById('days');
    if(days.length){ var mx=Math.max.apply(null,days.map(function(x){return x.c;}))||1;
      dEl.innerHTML = days.map(function(x){ var h=Math.round(x.c/mx*80); var dd=x.d.slice(5); return '<div class="d"><div class="col" style="height:'+h+'px" title="'+x.c+'"></div><div class="dl">'+dd+'</div></div>'; }).join('');
    } else dEl.innerHTML='<span class="muted">Sin datos persistentes (Postgres) aún.</span>';

    // Intención / sentimiento (agg o contadores en memoria)
    var intenc = agg? agg.intencion : {alta:c['intencion:alta']||0, media:c['intencion:media']||0, baja:c['intencion:baja']||0};
    var sentim = agg? agg.sentimiento : {positivo:c['sentimiento:positivo']||0, neutral:c['sentimiento:neutral']||0, negativo:c['sentimiento:negativo']||0};
    document.getElementById('intencion').innerHTML = dist(intenc,{alta:'#12b76a',media:'#f79009',baja:'#f04438'});
    document.getElementById('sentimiento').innerHTML = dist(sentim,{positivo:'#12b76a',neutral:'#98a2b3',negativo:'#f04438'});

    // Herramientas
    var tools = agg? (agg.tools||{}) : {consultar_programas:c['tool:consultar_programas']||0, detalle_programa:c['tool:detalle_programa']||0, registrar_interes_crm:c['tool:registrar_interes_crm']||0, escalar_a_humano:c['tool:escalar_a_humano']||0};
    var tkeys=Object.keys(tools).filter(function(k){return tools[k];});
    var tmax=tkeys.length?Math.max.apply(null,tkeys.map(function(k){return tools[k];})):0;
    document.getElementById('tools').innerHTML = tkeys.length? tkeys.map(function(k){return barRow(LBL[k]||k, tools[k], tmax);}).join('') : '<div class="muted">Sin uso registrado aún.</div>';

    // Reciente
    var rec=d.recent||[];
    document.getElementById('recent').innerHTML = rec.length? rec.map(function(r){
      var ts=r.ts? new Date(r.ts).toLocaleString('es-CL') : '';
      return '<tr><td>'+esc(ts)+'</td><td><span class="tag">'+esc(r.type)+'</span></td><td>'+esc(r.dialog_id||'')+'</td><td>'+esc(r.crm_entity||'')+'</td></tr>';
    }).join('') : '<tr><td colspan="4" class="muted">Sin actividad'+(d.db!=='postgres'?' (Postgres apagado: la actividad histórica requiere DATABASE_URL)':'')+'.</td></tr>';

    document.getElementById('status').innerHTML = '<span class="pill">KV: '+esc(d.kv)+' · DB: '+esc(d.db)+'</span>';
    document.getElementById('foot').textContent = 'Latencia LLM: '+num(live.llm.avgMs)+' ms (p95 '+num(live.llm.p95Ms)+' ms) · activo desde '+ new Date(d.startedAt).toLocaleString('es-CL') + ' · se actualiza cada 15 s';
  }

  var currentRange='7d';
  function load(){ fetch('/metrics/summary?range='+currentRange).then(function(r){return r.json();}).then(render).catch(function(e){ document.getElementById('status').innerHTML='<span class="pill err">error al cargar</span>'; }); }
  document.getElementById('ranges').addEventListener('click', function(e){
    var b=e.target.closest('button'); if(!b) return;
    currentRange=b.getAttribute('data-r');
    [].forEach.call(this.querySelectorAll('button'), function(x){ x.classList.toggle('on', x===b); });
    load();
  });
  load(); setInterval(load, 15000);
</script>
</body></html>`;
