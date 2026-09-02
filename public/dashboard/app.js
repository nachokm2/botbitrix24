try { if (window.BX24) BX24.init(function(){ try{ BX24.fitWindow(); }catch(e){} }); } catch(e){}

var LBL = {
  consultar_programas:'Consultas de programas', detalle_programa:'Detalle de programa',
  registrar_interes_crm:'Registro de datos (CRM)', escalar_a_humano:'Escalar a humano'
};
var esc = function(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); };
var num = function(n){ return (n==null?0:n).toLocaleString('es-CL'); };
// Icono "?" con tooltip nativo (title): ayuda a quien lee el panel a entender qué mide cada número
// sin tener que preguntar. Los títulos de sección (h2) llevan el suyo directo en index.html.
function hint(desc){ return desc ? '<i class="hint" title="'+esc(desc)+'">?</i>' : ''; }

function kpi(n,l,desc){ return '<div class="card kpi"><div class="n">'+n+'</div><div class="l">'+esc(l)+hint(desc)+'</div></div>'; }
function fmtSeg(s){ if(s==null) return '—'; s=Math.round(s); if(s<60) return s+' s'; var m=Math.floor(s/60), r=s%60; return m+' min '+r+' s'; }
function fmtMs(ms){ if(ms==null) return '—'; if(ms<1000) return ms+' ms'; return (ms/1000).toFixed(1)+' s'; }
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
    kpi(num(conversaciones),'Conversaciones','Diálogos distintos que el bot atendió en el período, en cualquier canal (WhatsApp, Web Chat, Instagram, Messenger).') +
    kpi(num(mensajes),'Mensajes','Turnos de conversación respondidos por el bot (una respuesta del bot = un mensaje).') +
    kpi(num(leads),'Leads capturados','Conversaciones donde se registró al menos un dato de contacto (nombre, correo o teléfono) en el CRM.') +
    kpi(num(escal),'Escalamientos a asesor','Veces que la conversación se derivó a un asesor humano: porque el cliente lo pidió, o automáticamente por score alto.') +
    kpi(num(consultas),'Consultas de programas','Veces que se usó la búsqueda de catálogo (consultar_programas) para encontrar o filtrar programas.') +
    kpi(num(etapas),'Etapas de deal movidas','Veces que el bot movió la etapa de un Deal en el CRM según el score del lead.') +
    kpi(scoreAvg,'Score promedio','Promedio de la nota 0-100 que un modelo de IA le asigna a cada conversación evaluada, estimando qué tan probable es que ese lead se matricule (interés claro, datos entregados, urgencia, tono). Esta nota también dispara mover de etapa, auto-llamar o auto-escalar.') +
    kpi(num(operador),'Intervención humana','Veces que un asesor/operador real escribió directamente en un chat de WhatsApp (no el bot) — se verifica contra Bitrix que sea un empleado real, no el cliente. Solo aplica a WhatsApp.') +
    kpi(num(errores),'Errores','Fallas técnicas registradas (ej. al guardar en el CRM o al auditar un evento).');

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
    kpi(captRate+'%','Tasa de captura de datos','% de conversaciones donde se logró registrar al menos un dato de contacto.') +
    kpi(escRate+'%','Tasa de escalamiento','% de conversaciones que terminaron derivadas a un asesor humano.') +
    kpi(tpc,'Mensajes por conversación','Promedio de respuestas del bot por conversación (más alto = conversaciones más largas).');
  document.getElementById('scorebuckets').innerHTML = dist(agg?agg.scoreBuckets:{}, {alto:'#12b76a',medio:'#f79009',bajo:'#f04438'});

  // Tiempos (respuesta/duración) por WhatsApp y por llamadas
  document.getElementById('tiempos').innerHTML =
    kpi(agg?fmtMs(agg.respuestaWhatsappMs):'—','Tiempo de respuesta · WhatsApp','Cuánto demora el bot en responder desde que llega el mensaje del cliente por WhatsApp.') +
    kpi(agg?fmtSeg(agg.duracionConvWhatsappSeg):'—','Duración de conversación · WhatsApp','Tiempo entre el primer y el último mensaje de la conversación.') +
    kpi(agg?fmtSeg(agg.duracionLlamadaSeg):'—','Duración de llamada · Voz','Duración promedio de las llamadas telefónicas que hace el agente de voz (IA).');

  // Marcha blanca por programa (tabla: 1 fila por programa piloto)
  var mb = d.marchaBlanca || [];
  var mbMoney = function(n){ return n==null ? '—' : '$'+num(n); };
  var mbEl = document.getElementById('marchablanca');
  if (mb.length) {
    var cols = ['Programa','Estado','Asesor norte','Asesor sur','Leads a la fecha','Matriculados','% cierre',
      'Ticket promedio','Leads antiguos','Leads nuevos','Mensajes','Escalamientos','SLA contacto asesor',
      'Escalados → matriculados','Llamadas IA'];
    var thead = '<thead><tr>'+cols.map(function(c){return '<th>'+esc(c)+'</th>';}).join('')+'</tr></thead>';
    var tbody = '<tbody>'+mb.map(function(p){
      var c = p.crm, b = p.bot;
      var sla = b && b.slaContactoSeg!=null ? fmtSeg(b.slaContactoSeg)+' ('+num(b.slaContactoN)+')' : '—';
      var escMatric = c ? num(c.escaladosMatriculados)+' / '+num(c.escaladosConDeal) : '—';
      return '<tr>'+
        '<td>'+esc(p.nombre)+'</td>'+
        '<td>'+esc(c&&c.estado?c.estado:'—')+'</td>'+
        '<td>'+esc(p.asesorNorte)+'</td>'+
        '<td>'+esc(p.asesorSur)+'</td>'+
        '<td>'+(c?num(c.dealsALaFecha):'—')+'</td>'+
        '<td>'+(c?num(c.matriculados):'—')+'</td>'+
        '<td>'+(c?c.pctCierre+'%':'—')+'</td>'+
        '<td>'+(c?mbMoney(c.ticketPromedio):'—')+'</td>'+
        '<td>'+(c?num(c.dealsAntiguos):'—')+'</td>'+
        '<td>'+(c?num(c.dealsNuevos):'—')+'</td>'+
        '<td>'+(b?num(b.mensajes):'—')+'</td>'+
        '<td>'+(b?num(b.escalamientos):'—')+'</td>'+
        '<td>'+sla+'</td>'+
        '<td>'+escMatric+'</td>'+
        '<td>'+(b?num(b.llamadasIA):'—')+'</td>'+
      '</tr>';
    }).join('')+'</tbody>';
    mbEl.innerHTML = thead+tbody;
  } else {
    mbEl.innerHTML = '<tr><td class="muted">Sin programas configurados.</td></tr>';
  }

  var dealUrl = function(id){ return d.bitrixDomain ? 'https://'+d.bitrixDomain+'/crm/deal/details/'+id+'/' : null; };
  var dealLinkCell = function(titulo, dealId){
    var url = dealUrl(dealId);
    return url ? '<a href="'+esc(url)+'" target="_blank" rel="noopener">'+esc(titulo)+' (#'+dealId+')</a>' : esc(titulo)+' (#'+dealId+')';
  };
  var matriculaCell = function(matriculado){
    return matriculado
      ? '<span class="tag" style="background:#d1fae5;color:#065f46">✓ Matriculado</span>'
      : '<span class="tag">En curso</span>';
  };

  // TODAS las negociaciones que el bot trabajó (conversó), haya escalado o no — más amplio que la
  // tabla de escalados de abajo (ej. Katherine: tuvo conversación pero se asignó a mano, nunca pasó
  // por escalar_a_humano, así que no aparecería en "Deals escalados a asesor").
  var negFilas = [];
  mb.forEach(function(p){
    var det = (p.crm && p.crm.negociacionesDetalle) || [];
    det.forEach(function(n){ negFilas.push({ programa: p.nombre, n: n }); });
  });
  var negResumenEl = document.getElementById('negresumen');
  var negEl = document.getElementById('negociaciones');
  if (negFilas.length) {
    var totalMatricN = negFilas.filter(function(f){return f.n.matriculado;}).length;
    var totalEscN = negFilas.filter(function(f){return f.n.escalado;}).length;
    negResumenEl.innerHTML = '<b>'+num(negFilas.length)+'</b> negociaciones trabajadas · <b>'+num(totalMatricN)+'</b> matriculadas ('+
      Math.round(totalMatricN/negFilas.length*100)+'%) · <b>'+num(totalEscN)+'</b> escaladas a un asesor';

    var ncols = ['Programa','Deal','Asesor','Etapa actual','Escalado','Matrícula'];
    var nthead = '<thead><tr>'+ncols.map(function(c){return '<th>'+esc(c)+'</th>';}).join('')+'</tr></thead>';
    var ntbody = '<tbody>'+negFilas.map(function(f){
      var n = f.n;
      var escLbl = !n.escalado
        ? '<span class="tag">No</span>'
        : '<span class="tag" style="background:#dbeafe;color:#1e40af">'+(n.motivo==='silencio'?'Silencio':'Pedido / score')+'</span>';
      return '<tr>'+
        '<td>'+esc(f.programa)+'</td>'+
        '<td>'+dealLinkCell(n.titulo, n.dealId)+'</td>'+
        '<td>'+esc(n.asesor||'—')+'</td>'+
        '<td>'+esc(n.stageNombre||n.stageId||'—')+'</td>'+
        '<td>'+escLbl+'</td>'+
        '<td>'+matriculaCell(n.matriculado)+'</td>'+
      '</tr>';
    }).join('')+'</tbody>';
    negEl.innerHTML = nthead+ntbody;
  } else {
    negResumenEl.innerHTML = '';
    negEl.innerHTML = '<tr><td class="muted">El bot todavía no tuvo conversaciones ligadas a un deal de estos programas.</td></tr>';
  }

  // Deals escalados a asesor (1 fila por deal, de los 2 programas piloto) — para ver la etapa real
  // de cada uno, quién lo tiene y si ya matriculó, no solo el conteo agregado de la tabla de arriba.
  var escFilas = [];
  mb.forEach(function(p){
    var det = (p.crm && p.crm.escaladosDetalle) || [];
    det.forEach(function(e){ escFilas.push({ programa: p.nombre, e: e }); });
  });
  var escResumenEl = document.getElementById('escresumen');
  var escEl = document.getElementById('escalados');
  if (escFilas.length) {
    var totalMatric = escFilas.filter(function(f){return f.e.matriculado;}).length;
    var porPrograma = {};
    escFilas.forEach(function(f){ porPrograma[f.programa] = (porPrograma[f.programa]||0)+1; });
    var resumenProgramas = Object.keys(porPrograma).map(function(k){ return num(porPrograma[k])+' '+esc(k); }).join(' · ');
    escResumenEl.innerHTML = '<b>'+num(escFilas.length)+'</b> deals escalados · <b>'+num(totalMatric)+'</b> matriculados ('+
      Math.round(totalMatric/escFilas.length*100)+'%) · '+resumenProgramas;

    var ecols = ['Programa','Deal','Asesor','Motivo','Etapa actual','Matrícula'];
    var ethead = '<thead><tr>'+ecols.map(function(c){return '<th>'+esc(c)+'</th>';}).join('')+'</tr></thead>';
    var etbody = '<tbody>'+escFilas.map(function(f){
      var e = f.e;
      var motivoLbl = e.motivo==='silencio' ? 'Silencio (sin respuesta)' : 'Pedido / score';
      return '<tr>'+
        '<td>'+esc(f.programa)+'</td>'+
        '<td>'+dealLinkCell(e.titulo, e.dealId)+'</td>'+
        '<td>'+esc(e.asesor||'—')+'</td>'+
        '<td><span class="tag">'+esc(motivoLbl)+'</span></td>'+
        '<td>'+esc(e.stageNombre||e.stageId||'—')+'</td>'+
        '<td>'+matriculaCell(e.matriculado)+'</td>'+
      '</tr>';
    }).join('')+'</tbody>';
    escEl.innerHTML = ethead+etbody;
  } else {
    escResumenEl.innerHTML = '';
    escEl.innerHTML = '<tr><td class="muted">Sin deals escalados a un asesor todavía.</td></tr>';
  }

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

  // Encabezado visible solo al imprimir/exportar a PDF (los botones de rango se ocultan ahí — ver
  // .print-only y @media print en styles.css) — deja constancia de qué rango y cuándo se generó.
  var RANGE_LBL={today:'Hoy','7d':'7 días','30d':'30 días',all:'Todo'};
  var rangeLbl=RANGE_LBL[d.range]||d.range;
  document.getElementById('printMeta').textContent = 'Rango: '+rangeLbl+' · Generado: '+new Date().toLocaleString('es-CL');

  document.getElementById('status').innerHTML = '<span class="pill">KV: '+esc(d.kv)+' · DB: '+esc(d.db)+'</span>';
  var tk=d.tokens||{}; var costStr=(tk.costUsd!=null)?(' · costo estim. US$'+tk.costUsd):'';
  document.getElementById('foot').textContent = 'Latencia LLM: '+num(live.llm.avgMs)+' ms (p95 '+num(live.llm.p95Ms)+' ms) · tokens '+num(tk.in)+' in / '+num(tk.out)+' out'+costStr+' · activo desde '+ new Date(d.startedAt).toLocaleString('es-CL') + ' · actualiza cada 15 s';
}

var K = new URLSearchParams(location.search).get('k') || '';
var currentRange='7d';
function load(){ fetch('/metrics/summary?range='+currentRange+(K?'&k='+encodeURIComponent(K):'')).then(function(r){return r.json();}).then(render).catch(function(e){ document.getElementById('status').innerHTML='<span class="pill err">error al cargar</span>'; }); }
document.getElementById('ranges').addEventListener('click', function(e){
  var b=e.target.closest('button'); if(!b) return;
  var r=b.getAttribute('data-r'); if(!r) return; // ej. #pdfBtn, que vive en la misma fila pero no es un rango
  currentRange=r;
  [].forEach.call(this.querySelectorAll('button[data-r]'), function(x){ x.classList.toggle('on', x===b); });
  load();
});
document.getElementById('pdfBtn').addEventListener('click', function(){ window.print(); });
load(); setInterval(load, 15000);
