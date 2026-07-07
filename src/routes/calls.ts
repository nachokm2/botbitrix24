import type { Request, Response } from 'express';
import { getState } from '../store';
import { config } from '../config';
import { getCallAnalytics, getCallAnalyticsFromDb, type CallFilters } from '../crm/callStats';
import { dbEnabled, dbCallsCount } from '../store/db';

const str = (v: unknown): string | undefined => {
  const s = String(v ?? '').trim();
  return s || undefined;
};

/** API JSON de analítica de llamadas (KPIs + series + tabla), con filtros por querystring. */
export async function callsData(req: Request, res: Response) {
  const st = await getState();
  const auth = st.auth ?? ({} as any);
  if (!config.bitrixWebhookUrl && !st.auth) {
    return res.json({ ok: false, error: 'Sin credenciales: configura BITRIX_WEBHOOK_URL (scope telephony) o instala el app.' });
  }
  const q = req.query;
  const type = q.type === 'in' || q.type === 'out' ? (q.type as 'in' | 'out') : undefined;
  const status = q.status === 'answered' || q.status === 'missed' ? (q.status as 'answered' | 'missed') : undefined;
  const f: CallFilters = {
    from: str(q.from),
    to: str(q.to),
    userId: q.userId ? Number(q.userId) : undefined,
    type,
    status,
    phone: str(q.phone),
    limit: q.limit ? Number(q.limit) : undefined,
  };
  try {
    // Si hay Postgres con llamadas sincronizadas → KPIs exactos del período; si no, muestra en vivo (REST).
    const useDb = dbEnabled() && (await dbCallsCount()) > 0;
    const data = useDb ? await getCallAnalyticsFromDb(f, auth) : await getCallAnalytics(f, auth);
    res.json({ ok: true, ...data });
  } catch (e) {
    res.json({ ok: false, error: String(e) });
  }
}

/** Página de analítica de llamadas (embebible en Bitrix24 vía placement). */
export function callsPage(_req: Request, res: Response) {
  res.set('Content-Type', 'text/html; charset=utf-8').send(CALLS_HTML);
}

const CALLS_HTML = `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Analítica de Llamadas — UA Postgrados</title>
<script src="//api.bitrix24.com/api/v1/"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  :root{--bg:#f4f6f9;--card:#fff;--ink:#1a2734;--muted:#7a8794;--line:#e6ebf1;--brand:#2f6fed;--ok:#12b76a;--warn:#f79009;--bad:#f04438}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  .wrap{max-width:1200px;margin:0 auto;padding:20px}
  header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:14px}
  h1{font-size:20px;margin:0}.sub{color:var(--muted);font-size:12px}
  a.link{color:var(--brand);text-decoration:none;font-size:12px}
  .pill{display:inline-block;padding:2px 8px;border-radius:999px;background:#eef3fe;color:var(--brand);font-size:12px;font-weight:600}
  .filters{display:flex;flex-wrap:wrap;gap:8px;align-items:end;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:14px}
  .filters .f{display:flex;flex-direction:column;gap:3px}.filters label{font-size:11px;color:var(--muted)}
  .filters input,.filters select{border:1px solid var(--line);border-radius:8px;padding:6px 8px;font:inherit;font-size:13px;background:#fff}
  .btn{border:1px solid var(--brand);background:var(--brand);color:#fff;border-radius:8px;padding:7px 14px;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
  .btn.sec{background:#fff;color:#42526e;border-color:var(--line)}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}
  .kpi .n{font-size:24px;font-weight:700;line-height:1.1}.kpi .l{color:var(--muted);font-size:12px;margin-top:4px}
  .sec{margin-top:18px}.sec h2{font-size:14px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin:0 0 10px}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:820px){.row{grid-template-columns:1fr}}
  table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
  th{color:var(--muted);font-weight:600;cursor:pointer;user-select:none}th:hover{color:var(--ink)}
  .tag{font-size:11px;padding:1px 7px;border-radius:6px;background:#eef1f5;color:#42526e}
  .tag.in{background:#eaf7ef;color:#12b76a}.tag.out{background:#eef3fe;color:#2f6fed}
  .tag.ok{background:#eaf7ef;color:#12b76a}.tag.miss{background:#fdeceb;color:#f04438}
  .muted{color:var(--muted)}.err{color:var(--bad)}
  .pag{display:flex;gap:6px;align-items:center;justify-content:flex-end;margin-top:10px}
  .pag button{border:1px solid var(--line);background:#fff;border-radius:8px;padding:5px 10px;cursor:pointer;font:inherit;font-size:12px}
  .tablebar{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap}
  canvas{max-height:280px}
  footer{margin-top:16px;color:var(--muted);font-size:11px;text-align:center}
</style></head>
<body><div class="wrap">
  <header>
    <div><h1>Analítica de Llamadas</h1><div class="sub">Universidad Autónoma de Chile · telefonía Bitrix24 (asesores + agente de voz)</div></div>
    <div><a class="link" href="/app">← Panel del agente</a> &nbsp; <span id="status"><span class="pill">cargando…</span></span></div>
  </header>

  <div class="filters" id="filters">
    <div class="f"><label>Desde</label><input type="date" id="from"></div>
    <div class="f"><label>Hasta</label><input type="date" id="to"></div>
    <div class="f"><label>Asesor</label><select id="userId"><option value="">Todos</option></select></div>
    <div class="f"><label>Tipo</label><select id="type"><option value="">Todos</option><option value="in">Entrante</option><option value="out">Saliente</option></select></div>
    <div class="f"><label>Estado</label><select id="status"><option value="">Todos</option><option value="answered">Contestada</option><option value="missed">Perdida</option></select></div>
    <div class="f"><label>Teléfono</label><input type="text" id="phone" placeholder="+569..."></div>
    <div class="f"><label>&nbsp;</label><button class="btn" id="apply">Aplicar</button></div>
    <div class="f"><label>&nbsp;</label><button class="btn sec" id="reset">Limpiar</button></div>
  </div>

  <div class="grid" id="kpis"></div>

  <div class="sec row">
    <div class="card"><h2 style="margin-top:0">Llamadas por hora del día (entrante vs saliente)</h2><canvas id="chHora"></canvas></div>
    <div class="card"><h2 style="margin-top:0">Llamadas por día de la semana</h2><canvas id="chDia"></canvas></div>
  </div>
  <div class="sec row">
    <div class="card"><h2 style="margin-top:0">Entrantes vs Salientes</h2><canvas id="chTipo"></canvas></div>
    <div class="card"><h2 style="margin-top:0">Contestadas vs Perdidas</h2><canvas id="chEstado"></canvas></div>
  </div>

  <div class="sec"><h2>Historial de llamadas</h2><div class="card">
    <div class="tablebar">
      <input type="text" id="search" placeholder="Buscar por contacto o teléfono…" style="border:1px solid var(--line);border-radius:8px;padding:6px 10px;font:inherit;font-size:13px;min-width:240px">
      <div class="sub" id="tcount"></div>
    </div>
    <div style="overflow-x:auto"><table id="tbl">
      <thead><tr>
        <th data-k="contacto">Contacto</th><th data-k="telefono">Teléfono</th><th data-k="tipo">Tipo</th>
        <th data-k="fecha">Fecha y hora</th><th data-k="duracion">Duración</th><th data-k="usuario">Asesor</th>
        <th data-k="estado">Estado</th><th>Grabación</th>
      </tr></thead>
      <tbody id="rows"></tbody>
    </table></div>
    <div class="pag" id="pag"></div>
  </div></div>

  <footer id="foot"></footer>
</div>
<script>
  try { if (window.BX24) BX24.init(function(){ try{ BX24.fitWindow(); }catch(e){} }); } catch(e){}
  var esc=function(s){return String(s==null?'':s).replace(/[&<>]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});};
  var num=function(n){return (n==null?0:n).toLocaleString('es-CL');};
  var pad=function(n){return (n<10?'0':'')+n;};
  var dur=function(s){s=Number(s)||0;var m=Math.floor(s/60);var x=s%60;return m+':'+pad(x);};
  var fdate=function(iso){var d=new Date(iso);return isNaN(d.getTime())?esc(iso):d.toLocaleString('es-CL');};
  var DIAS=['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];

  function kpi(n,l){return '<div class="card kpi"><div class="n">'+n+'</div><div class="l">'+l+'</div></div>';}
  function ymd(d){return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());}

  // Rango por defecto: últimos 30 días
  (function(){var now=new Date();var ago=new Date(now.getTime()-30*864e5);document.getElementById('from').value=ymd(ago);document.getElementById('to').value=ymd(now);})();

  var ALL=[], view=[], page=1, per=15, sortK='fecha', sortDir=-1, charts={};

  function qs(){
    var p=new URLSearchParams();
    ['from','to','userId','type','status','phone'].forEach(function(id){var v=document.getElementById(id).value; if(v) p.set(id,v);});
    return p.toString();
  }

  function drawCharts(d){
    var ctxH=document.getElementById('chHora'), ctxD=document.getElementById('chDia'), ctxT=document.getElementById('chTipo'), ctxE=document.getElementById('chEstado');
    Object.keys(charts).forEach(function(k){ if(charts[k]) charts[k].destroy(); });
    var horas=d.porHora||[]; var dias=d.porDia||[];
    charts.h=new Chart(ctxH,{type:'bar',data:{labels:horas.map(function(x){return x.h+'h';}),datasets:[
      {label:'Entrantes',data:horas.map(function(x){return x.entrantes;}),backgroundColor:'#12b76a'},
      {label:'Salientes',data:horas.map(function(x){return x.salientes;}),backgroundColor:'#2f6fed'}]},
      options:{responsive:true,scales:{x:{stacked:true},y:{stacked:true,beginAtZero:true}},plugins:{legend:{position:'bottom'}}}});
    charts.d=new Chart(ctxD,{type:'bar',data:{labels:dias.map(function(x){return DIAS[x.d];}),datasets:[
      {label:'Entrantes',data:dias.map(function(x){return x.entrantes;}),backgroundColor:'#12b76a'},
      {label:'Salientes',data:dias.map(function(x){return x.salientes;}),backgroundColor:'#2f6fed'}]},
      options:{responsive:true,scales:{y:{beginAtZero:true}},plugins:{legend:{position:'bottom'}}}});
    var k=d.kpis||{};
    charts.t=new Chart(ctxT,{type:'doughnut',data:{labels:['Entrantes','Salientes'],datasets:[{data:[k.entrantes||0,k.salientes||0],backgroundColor:['#12b76a','#2f6fed']}]},options:{plugins:{legend:{position:'bottom'}}}});
    charts.e=new Chart(ctxE,{type:'doughnut',data:{labels:['Contestadas','Perdidas'],datasets:[{data:[k.contestadas||0,k.perdidas||0],backgroundColor:['#12b76a','#f04438']}]},options:{plugins:{legend:{position:'bottom'}}}});
  }

  function renderKpis(k){
    document.getElementById('kpis').innerHTML =
      kpi(num(k.total),'Llamadas totales')+kpi(num(k.entrantes),'Entrantes')+kpi(num(k.salientes),'Salientes')+
      kpi(num(k.contestadas),'Contestadas')+kpi(num(k.perdidas),'Perdidas')+
      kpi(dur(k.durProm),'Duración promedio')+kpi(dur(k.durTotal),'Duración total')+
      kpi(k.tasaContestadas+'%','Tasa contestadas')+kpi(k.tasaPerdidas+'%','Tasa perdidas');
  }

  function applySort(){
    view.sort(function(a,b){
      var x=a[sortK], y=b[sortK];
      if(sortK==='duracion'){x=Number(x)||0;y=Number(y)||0;}
      else {x=String(x==null?'':x).toLowerCase();y=String(y==null?'':y).toLowerCase();}
      return x<y?-1*sortDir:x>y?1*sortDir:0;
    });
  }
  function renderTable(){
    var q=document.getElementById('search').value.toLowerCase().trim();
    view = q? ALL.filter(function(r){return (String(r.contacto||'')+' '+r.telefono).toLowerCase().indexOf(q)>=0;}) : ALL.slice();
    applySort();
    var pages=Math.max(1,Math.ceil(view.length/per)); if(page>pages)page=pages;
    var slice=view.slice((page-1)*per, page*per);
    document.getElementById('rows').innerHTML = slice.length? slice.map(function(r){
      var tc=r.tipo==='saliente'||r.tipo==='callback'?'out':'in';
      var sc=r.contestada?'ok':'miss';
      var rec=r.grabacion?('<a class="link" href="'+esc(r.grabacion)+'" target="_blank">▶ oír</a>'):'<span class="muted">—</span>';
      return '<tr><td>'+esc(r.contacto||'—')+'</td><td>'+esc(r.telefono)+'</td>'+
        '<td><span class="tag '+tc+'">'+esc(r.tipo)+'</span></td><td>'+fdate(r.fecha)+'</td>'+
        '<td>'+dur(r.duracion)+'</td><td>'+esc(r.usuario)+'</td>'+
        '<td><span class="tag '+sc+'">'+esc(r.estado)+'</span></td><td>'+rec+'</td></tr>';
    }).join('') : '<tr><td colspan="8" class="muted">Sin llamadas para estos filtros.</td></tr>';
    document.getElementById('tcount').textContent = view.length+' llamada(s)';
    document.getElementById('pag').innerHTML = '<button id="prev">‹</button><span class="sub">Página '+page+' de '+pages+'</span><button id="next">›</button>';
    document.getElementById('prev').onclick=function(){if(page>1){page--;renderTable();}};
    document.getElementById('next').onclick=function(){if(page<pages){page++;renderTable();}};
  }

  function load(){
    document.getElementById('status').innerHTML='<span class="pill">cargando…</span>';
    fetch('/calls/data?'+qs()).then(function(r){return r.json();}).then(function(d){
      if(!d.ok){ document.getElementById('status').innerHTML='<span class="pill err">'+esc(d.error||'error')+'</span>'; return; }
      // Rellena el select de asesores (una vez, con los que aparezcan)
      var sel=document.getElementById('userId'); if(sel.options.length<=1 && d.usuarios){ d.usuarios.forEach(function(u){var o=document.createElement('option');o.value=u.id;o.textContent=u.nombre;sel.appendChild(o);}); }
      renderKpis(d.kpis||{}); drawCharts(d);
      ALL=d.rows||[]; page=1; renderTable();
      if(d.mode==='db'){
        document.getElementById('status').innerHTML='<span class="pill">'+num(d.total)+' llamadas · KPIs exactos</span>';
        var extra = d.total>d.fetched? (' · tabla: últimas '+num(d.fetched)+' de '+num(d.total)) : '';
        document.getElementById('foot').textContent='KPIs y gráficos sobre TODO el rango ('+num(d.total)+' llamadas)'+extra+' · fuente: Postgres (sincronizado)';
      } else {
        document.getElementById('status').innerHTML='<span class="pill">'+num(d.fetched)+' llamadas (muestra)</span>';
        var partial = d.total>d.fetched? (' · KPIs sobre muestra de '+num(d.fetched)+' de '+num(d.total)+' (acorta el rango o sincroniza a Postgres para exactos)') : '';
        document.getElementById('foot').textContent='Fuente: voximplant.statistic.get en vivo'+partial;
      }
    }).catch(function(e){ document.getElementById('status').innerHTML='<span class="pill err">error al cargar</span>'; });
  }

  document.getElementById('apply').onclick=load;
  document.getElementById('reset').onclick=function(){['userId','type','status','phone'].forEach(function(id){document.getElementById(id).value='';}); load();};
  document.getElementById('search').addEventListener('input', function(){page=1;renderTable();});
  [].forEach.call(document.querySelectorAll('#tbl th[data-k]'), function(th){ th.onclick=function(){var k=th.getAttribute('data-k'); if(sortK===k)sortDir*=-1; else {sortK=k;sortDir=1;} renderTable();}; });
  load();
</script>
</body></html>`;
