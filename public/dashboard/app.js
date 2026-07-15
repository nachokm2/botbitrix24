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
function progName(k){ var s=String(k||''); if(s.indexOf('http')===0){ s=s.replace(/\/+$/,''); s=s.substring(s.lastIndexOf('/')+1); } return s.replace(/-/g,' '); }
function barsRows(rows, labFn){ rows=rows||[]; if(!rows.length) return '<div class="muted">Sin datos aún.</div>'; var mx=Math.max.apply(null,rows.map(function(r){return r.c;}))||1; return rows.map(function(r){ return barRow(labFn?labFn(r):r.k, r.c, mx); }).join(''); }

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
  var operador = agg? agg.operadorMsgs : pick(c.operator_msg);

  document.getElementById('kpis').innerHTML =
    kpi(num(conversaciones),'Conversaciones') + kpi(num(mensajes),'Mensajes') +
    kpi(num(leads),'Leads capturados') + kpi(num(escal),'Escalamientos a asesor') +
    kpi(num(consultas),'Consultas de programas') + kpi(num(etapas),'Etapas de deal movidas') +
    kpi(scoreAvg,'Score promedio') + kpi(num(operador),'Intervención humana') + kpi(num(errores),'Errores');

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

  // Conversión del bot
  var capt = agg? agg.capturaConvs : 0, escConv = agg? agg.escalConvs : 0;
  var captRate = conversaciones>0? Math.round(capt/conversaciones*100) : 0;
  var escRate = conversaciones>0? Math.round(escConv/conversaciones*100) : 0;
  var tpc = conversaciones>0? (mensajes/conversaciones).toFixed(1) : '0';
  document.getElementById('convkpis').innerHTML =
    kpi(captRate+'%','Tasa de captura de datos') + kpi(escRate+'%','Tasa de escalamiento') + kpi(tpc,'Mensajes por conversación');
  document.getElementById('scorebuckets').innerHTML = dist(agg?agg.scoreBuckets:{}, {alto:'#12b76a',medio:'#f79009',bajo:'#f04438'});

  // Demanda de programas
  document.getElementById('topprog').innerHTML = barsRows(agg&&agg.topProgramas, function(r){return progName(r.k);});
  document.getElementById('topinteres').innerHTML = barsRows(agg&&agg.topInteres, function(r){return r.k;});
  document.getElementById('porfacultad').innerHTML = barsRows(agg&&agg.porFacultad, function(r){return r.k;});
  document.getElementById('portipo').innerHTML = dist(agg?agg.porTipo:{});
  var gapsRows=(agg&&agg.gapsCatalogo)||[];
  document.getElementById('gaps').innerHTML = gapsRows.length? barsRows(gapsRows, function(r){return progName(r.k);}) : '<div class="muted">Sin gaps detectados 🎉</div>';

  // Horario de contacto (0-23h)
  var hmap={}; ((agg&&agg.porHora)||[]).forEach(function(x){hmap[x.h]=x.c;});
  var hmx=1; for(var h=0;h<24;h++) hmx=Math.max(hmx, hmap[h]||0);
  var hbars=[]; for(var h2=0;h2<24;h2++){ var v=hmap[h2]||0; hbars.push('<div class="d"><div class="col" style="height:'+Math.round(v/hmx*80)+'px" title="'+v+'"></div><div class="dl">'+h2+'</div></div>'); }
  document.getElementById('horas').innerHTML = agg? hbars.join('') : '<span class="muted">Requiere Postgres (DATABASE_URL).</span>';

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
  var tk=d.tokens||{}; var costStr=(tk.costUsd!=null)?(' · costo estim. US$'+tk.costUsd):'';
  document.getElementById('foot').textContent = 'Latencia LLM: '+num(live.llm.avgMs)+' ms (p95 '+num(live.llm.p95Ms)+' ms) · tokens '+num(tk.in)+' in / '+num(tk.out)+' out'+costStr+' · activo desde '+ new Date(d.startedAt).toLocaleString('es-CL') + ' · actualiza cada 15 s';
}

var K = new URLSearchParams(location.search).get('k') || '';
var currentRange='7d';
function load(){ fetch('/metrics/summary?range='+currentRange+(K?'&k='+encodeURIComponent(K):'')).then(function(r){return r.json();}).then(render).catch(function(e){ document.getElementById('status').innerHTML='<span class="pill err">error al cargar</span>'; }); }
document.getElementById('ranges').addEventListener('click', function(e){
  var b=e.target.closest('button'); if(!b) return;
  currentRange=b.getAttribute('data-r');
  [].forEach.call(this.querySelectorAll('button'), function(x){ x.classList.toggle('on', x===b); });
  load();
});
load(); setInterval(load, 15000);
