// BX24.fitWindow() ajusta el alto del iframe de Bitrix24 al contenido — pero acá se llamaba UNA sola
// vez al cargar el script, antes de que render() pintara los datos reales (todavía no había ni
// siquiera un fetch en curso). Bitrix fijaba el iframe a esa altura casi vacía y el contenido real
// (mucho más alto) desbordaba, mostrando 2 barras de scroll: la del iframe fijo + la del documento
// interno. Se guarda si BX24 quedó listo y se vuelve a llamar al final de cada render() (el alto
// puede cambiar entre polls: más/menos filas en las tablas de negociaciones/escalados).
var bxReady = false;
try { if (window.BX24) BX24.init(function(){ bxReady = true; fitBx(); }); } catch(e){}
function fitBx(){ try{ if(bxReady) BX24.fitWindow(); }catch(e){} }

var LBL = {
  consultar_programas:'Consultas de programas', detalle_programa:'Detalle de programa',
  registrar_interes_crm:'Registro de datos (CRM)', escalar_a_humano:'Escalar a humano'
};
var esc = function(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); };
var num = function(n){ return (n==null?0:n).toLocaleString('es-CL'); };
// Icono "?" con tooltip nativo (title): ayuda a quien lee el panel a entender qué mide cada número
// sin tener que preguntar. Los títulos de sección (h2) llevan el suyo directo en index.html.
function hint(desc){ return desc ? '<i class="hint" title="'+esc(desc)+'">?</i>' : ''; }

// Color + ícono por tarjeta del scorecard superior (barra de acento a la izquierda + badge) — solo
// decorativo, no cambia el dato. Sin key (kpi() reutilizado en "Conversión del bot"/"Tiempos") queda
// con el estilo neutro por defecto.
var KPI_META = {
  conversaciones:{color:'#2f6fed',icon:'💬'}, mensajes:{color:'#6366f1',icon:'✉️'},
  leads:{color:'#12b76a',icon:'🎯'}, escal:{color:'#f79009',icon:'🧑‍💼'},
  consultas:{color:'#0891b2',icon:'🔎'}, etapas:{color:'#7c3aed',icon:'🔀'},
  score:{color:'#0d9488',icon:'⭐'}, operador:{color:'#f79009',icon:'🗣️'},
  matriculas:{color:'#12b76a',icon:'🎓'}, errores:{color:'#f04438',icon:'⚠️'},
};
// Última cifra mostrada por tarjeta (persiste entre polls de 15s) — permite que el conteo animado
// arranque desde 0 solo la PRIMERA vez, y en los refrescos siguientes solo se mueva si el valor
// realmente cambió (evita que los números "salten" a cada rato sin motivo).
var lastKpiValues = {};
function kpi(n,l,desc,key){
  var meta = (key && KPI_META[key]) || null;
  var numeric = typeof n === 'number';
  var accentStyle = meta ? ' style="--accent:'+meta.color+'"' : '';
  var icoHtml = meta ? '<span class="ico" style="background:'+meta.color+'22;color:'+meta.color+'">'+meta.icon+'</span>' : '';
  var nHtml = (numeric && key) ? num(lastKpiValues[key]||0) : esc(n);
  return '<div class="card kpi"'+accentStyle+'>'+icoHtml
    +'<div class="n"'+(numeric&&key?' data-key="'+key+'" data-target="'+n+'"':'')+'>'+nHtml+'</div>'
    +'<div class="l">'+esc(l)+hint(desc)+'</div></div>';
}
// Cuenta ascendente/descendente suave hacia el valor nuevo — solo anima la DIFERENCIA respecto al
// último valor mostrado (no arranca de 0 cada 15s, para que un panel dejado abierto no parpadee).
function animateKpis(){
  [].forEach.call(document.querySelectorAll('#kpis .n[data-key]'), function(el){
    var key = el.getAttribute('data-key');
    var target = Number(el.getAttribute('data-target'))||0;
    var from = lastKpiValues[key]||0;
    lastKpiValues[key] = target;
    if(from===target){ el.textContent = num(target); return; }
    var start=null, dur=650;
    function step(ts){
      if(!start) start=ts;
      var p=Math.min(1,(ts-start)/dur), eased=1-Math.pow(1-p,3);
      el.textContent = num(Math.round(from+(target-from)*eased));
      if(p<1) requestAnimationFrame(step); else el.textContent = num(target);
    }
    requestAnimationFrame(step);
  });
}
function fmtSeg(s){ if(s==null) return '—'; s=Math.round(s); if(s<60) return s+' s'; var m=Math.floor(s/60), r=s%60; return m+' min '+r+' s'; }
function fmtMs(ms){ if(ms==null) return '—'; if(ms<1000) return ms+' ms'; return (ms/1000).toFixed(1)+' s'; }
// La primera vez que se pinta el panel, las barras/columnas "crecen" desde 0 (ver growAnimated) — da
// una entrada vistosa al abrir el panel. En los refrescos siguientes (cada 15s) se pintan directo en
// su valor final, sin animación, para que un panel dejado abierto en una pantalla no parpadee solo.
var firstRender = true;
function barRow(lab,v,max,color){ var w=max>0?Math.round(v/max*100):0; var wStyle=firstRender?0:w; return '<div class="bar"><div class="lab">'+esc(lab)+'</div><div class="track"><div class="fill" data-w="'+w+'" style="width:'+wStyle+'%'+(color?';background:'+color:'')+'"></div></div><div class="v">'+num(v)+'</div></div>'; }
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
  // Matrículas reales de los 2 programas piloto (combinados) — a diferencia de las demás tarjetas,
  // NO sigue el selector Hoy/7d/30d/Todo: es el acumulado desde que arrancó el piloto (mismo dato que
  // "Piloto: proyección vs. real" más abajo), porque matricular es un proceso que tarda más que el
  // rango típico que se mira acá.
  var matriculasPiloto = (d.piloto && d.piloto.real && d.piloto.real.matriculas) || 0;

  document.getElementById('kpis').innerHTML =
    kpi(conversaciones,'Conversaciones','Diálogos distintos que el bot atendió en el período, en cualquier canal (WhatsApp, Web Chat, Instagram, Messenger).','conversaciones') +
    kpi(mensajes,'Mensajes','Turnos de conversación respondidos por el bot (una respuesta del bot = un mensaje).','mensajes') +
    kpi(leads,'Leads capturados','Conversaciones donde se registró al menos un dato de contacto (nombre, correo o teléfono) en el CRM.','leads') +
    kpi(escal,'Escalamientos a asesor','El BOT decidió derivar la conversación a un asesor: porque el cliente lo pidió, o automáticamente por score alto. Es la acción del bot al derivar, no confirma que un asesor ya haya respondido. Cuenta en cualquier canal (WhatsApp, Web Chat, Instagram, Messenger).','escal') +
    kpi(consultas,'Consultas de programas','Veces que se usó la búsqueda de catálogo (consultar_programas) para encontrar o filtrar programas.','consultas') +
    kpi(etapas,'Etapas de deal movidas','Veces que el bot movió la etapa de un Deal en el CRM según el score del lead.','etapas') +
    kpi(scoreAvg,'Score promedio','Promedio de la nota 0-100 que un modelo de IA le asigna a cada conversación evaluada, estimando qué tan probable es que ese lead se matricule (interés claro, datos entregados, urgencia, tono). Esta nota también dispara mover de etapa, auto-llamar o auto-escalar.','score') +
    kpi(operador,'Intervención humana','Veces que un asesor/operador REAL escribió directamente en un chat de WhatsApp (no el bot; se verifica contra Bitrix que sea un empleado, no el cliente). Solo cuenta WhatsApp — por eso puede ser menor que "Escalamientos a asesor" (que suma todos los canales y no confirma que el asesor ya haya escrito), o mayor, si un asesor entra a conversar sin que el bot haya escalado antes.','operador') +
    kpi(matriculasPiloto,'Matrículas (piloto)','Matrículas reales entre las negociaciones con las que el bot conversó/escaló, de los 2 programas piloto combinados. Acumulado desde el inicio del piloto — NO cambia con el selector Hoy/7 días/30 días/Todo (ver detalle en "Piloto: proyección vs. real" y "Negociaciones que trabajó el bot").','matriculas') +
    kpi(errores,'Errores','Fallas técnicas registradas (ej. al guardar en el CRM o al auditar un evento).','errores');
  animateKpis();

  // Piloto: proyección (correo de lanzamiento a la jefatura) vs. real acumulado (2 programas
  // combinados, no por separado — así se presentó la proyección: "284 leads", no "142 + 142").
  var pil = d.piloto || {};
  var proy = pil.proyeccion || {};
  var real = pil.real || {};
  var rangoTxt = function(min, max){ return num(min)+'–'+num(max); };
  var cumplCell = function(realVal, proyMid){
    if (!proyMid) return '—';
    var pct = Math.round((realVal||0)/proyMid*100);
    var color = pct>=80 ? '#12b76a' : pct>=40 ? '#f79009' : '#f04438';
    return '<b style="color:'+color+'">'+pct+'%</b>';
  };
  var filasPiloto = [
    { label:'Leads ingresados', proy:num(proy.leadsEsperados), real:real.leadsIngresados, proyMid:proy.leadsEsperados },
    { label:'Leads atendidos por el bot (primera respuesta automática)', proy:num(proy.primeraRespuestaAutomatica), real:real.leadsAtendidos, proyMid:proy.primeraRespuestaAutomatica },
    { label:'Mensajes enviados por IA', proy:num(proy.mensajesIA), real:real.mensajes, proyMid:proy.mensajesIA },
    { label:'Llamadas realizadas', proy:num(proy.llamadas), real:real.llamadasRealizadas, proyMid:proy.llamadas },
    { label:'Llamadas solicitadas por el cliente', proy:'—', real:real.llamadasSolicitadas, proyMid:0 },
    { label:'Llamadas contestadas', proy:rangoTxt(proy.llamadasContestadasMin,proy.llamadasContestadasMax), real:real.llamadasContestadas, proyMid:(proy.llamadasContestadasMin+proy.llamadasContestadasMax)/2 },
    { label:'Minutos de llamadas', proy:num(proy.minutosLlamadas), real:real.minutosLlamadas, proyMid:proy.minutosLlamadas },
    { label:'Escalamientos a ejecutivo', proy:rangoTxt(proy.escalamientosMin,proy.escalamientosMax), real:real.escalamientos, proyMid:(proy.escalamientosMin+proy.escalamientosMax)/2,
      nota: num(real.escalamientosExplicitos)+' por pedido del cliente / score alto · '+num(real.escalamientosPorSilencio)+' por quedarse en silencio' },
    { label:'Leads de alta intención', proy:rangoTxt(proy.leadsAltaIntencionMin,proy.leadsAltaIntencionMax), real:real.leadsAltaIntencion, proyMid:(proy.leadsAltaIntencionMin+proy.leadsAltaIntencionMax)/2 },
    { label:'Leads que siguen avanzando en Bitrix24', proy:'—', real:real.leadsAvanzando, proyMid:0 },
    { label:'Matrículas asociadas a leads gestionados por el bot', proy:'—', real:real.matriculas, proyMid:0 },
  ];
  var pilThead = '<thead><tr><th>Indicador</th><th>Proyectado</th><th>Real</th><th>Cumplimiento</th></tr></thead>';
  var pilTbody = '<tbody>'+filasPiloto.map(function(f){
    var notaHtml = f.nota ? '<div class="sub" style="font-size:11px;margin-top:2px">'+esc(f.nota)+'</div>' : '';
    return '<tr><td>'+esc(f.label)+'</td><td>'+f.proy+'</td><td>'+num(f.real)+notaHtml+'</td><td>'+cumplCell(f.real,f.proyMid)+'</td></tr>';
  }).join('')+'</tbody>';
  document.getElementById('piloto').innerHTML = pilThead+pilTbody;

  // Máquina virtual GCP: sin VM encendida para las llamadas de WhatsApp, ese componente no aplica
  // (se sacó también del total proyectado — ver PILOTO_PROYECCION en routes/dashboard.ts).
  var costoClaudeTxt = real.costoUsdClaude!=null ? ('US$'+real.costoUsdClaude) : '—';
  var costoRailwayTxt = real.costoUsdRailway!=null ? ('US$'+real.costoUsdRailway) : '—';
  var sumaCostoReal = (real.costoUsdClaude||0) + (real.costoUsdRailway||0);
  var filasCosto = [
    { label:'Vapi (llamadas IA)', proy:'US$25–40', real:'—' },
    { label:'ElevenLabs (voz)', proy:'US$50–150', real:'—' },
    { label:'Claude (procesamiento IA)', proy:'US$20–60', real:costoClaudeTxt },
    { label:'Railway / infraestructura', proy:'US$20–40', real:costoRailwayTxt },
    { label:'Margen de contingencia', proy:'US$30–50', real:'—' },
    { label:'TOTAL', proy:'US$'+proy.costoUsdMin+'–'+proy.costoUsdMax, real:'US$'+sumaCostoReal.toFixed(2)+' (falta sumar Vapi/ElevenLabs desde la factura de cada proveedor)' },
  ];
  var costThead = '<thead><tr><th>Componente</th><th>Proyectado</th><th>Real</th></tr></thead>';
  var costTbody = '<tbody>'+filasCosto.map(function(f){ return '<tr><td>'+esc(f.label)+'</td><td>'+esc(f.proy)+'</td><td>'+esc(f.real)+'</td></tr>'; }).join('')+'</tbody>';
  document.getElementById('pilotocostos').innerHTML = costThead+costTbody;

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
  var hbars=[]; for(var h2=0;h2<24;h2++){ var v=hmap[h2]||0; var hh=Math.round(v/hmx*80); hbars.push('<div class="d"><div class="col" data-h="'+hh+'" style="height:'+(firstRender?0:hh)+'px" title="'+v+'"></div><div class="dl">'+h2+'</div></div>'); }
  document.getElementById('horas').innerHTML = agg? hbars.join('') : '<span class="muted">Requiere Postgres (DATABASE_URL).</span>';

  // Mensajes por día
  var days = (agg&&agg.porDia)||[]; var dEl=document.getElementById('days');
  if(days.length){ var mx=Math.max.apply(null,days.map(function(x){return x.c;}))||1;
    dEl.innerHTML = days.map(function(x){ var h=Math.round(x.c/mx*80); var dd=x.d.slice(5); return '<div class="d"><div class="col" data-h="'+h+'" style="height:'+(firstRender?0:h)+'px" title="'+x.c+'"></div><div class="dl">'+dd+'</div></div>'; }).join('');
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

  if(firstRender) growAnimated();
  firstRender = false;
  fitBx();
}
// Hace crecer las barras/columnas desde 0 hasta su valor real (data-w/data-h) — solo se llama en el
// primer render (ver firstRender): un doble requestAnimationFrame fuerza que el navegador pinte el
// estado "0" antes de pasar al valor final, si no la transición CSS no llega a dispararse.
function growAnimated(){
  requestAnimationFrame(function(){
    requestAnimationFrame(function(){
      [].forEach.call(document.querySelectorAll('.bar .fill[data-w]'), function(el){ el.style.width = el.getAttribute('data-w')+'%'; });
      [].forEach.call(document.querySelectorAll('.days .col[data-h]'), function(el){ el.style.height = el.getAttribute('data-h')+'px'; });
    });
  });
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
