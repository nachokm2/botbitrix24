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
  var K=new URLSearchParams(location.search).get('k'); if(K) p.set('k', K);
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
