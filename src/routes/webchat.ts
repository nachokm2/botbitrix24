import type { Request, Response } from 'express';
import crypto from 'crypto';
import { webchatTurn } from '../channels/webchat';
import { getState, EMPTY_AUTH } from '../store';
import { getRedisClient } from '../store/kv';
import { log } from '../log';

// Rutas del canal Web Chat (M3): API de mensaje + widget embebible.
// Endpoint público (es un chat de sitio): protegido con rate-limit por IP (en index.ts) + un tope de
// mensajes por conversación para acotar costo/abuso, más un allowlist de Origin/Referer opcional
// (requireAllowedOrigin en index.ts, ver ALT-Alta-2 de la auditoría — vacío si no hay BASE_URL/
// WEBCHAT_ALLOWED_ORIGINS configurados, para no romper el comportamiento previo).

// El id de conversación DEBE tener el prefijo "wc-": así namespacea la memoria del visitante y evita
// que un cliente malicioso pase un dialogId de otro canal (p. ej. Open Lines) para leer su historial.
const VALID_ID = /^wc-[A-Za-z0-9_-]{6,64}$/;
const MAX_MSGS_POR_CONVERSACION = 60;
const MAX_MSG_LEN = 2000;

const memCounts = new Map<string, { n: number; exp: number }>();

async function bumpCount(id: string): Promise<number> {
  const redis = getRedisClient();
  const key = `webchat:count:${id}`;
  if (redis) {
    try {
      const n = await redis.incr(key);
      if (n === 1) await redis.expire(key, 24 * 3600);
      return n;
    } catch {
      /* fail-open al contador en memoria */
    }
  }
  const now = Date.now();
  const e = memCounts.get(id);
  if (!e || e.exp < now) {
    memCounts.set(id, { n: 1, exp: now + 24 * 3600 * 1000 });
    return 1;
  }
  e.n++;
  return e.n;
}

/** POST /webchat/message — recibe {conversationId?, message} y devuelve {conversationId, reply}. */
export async function webchatMessage(req: Request, res: Response) {
  const body: any = req.body ?? {};
  let conversationId = String(body.conversationId ?? '');
  if (!VALID_ID.test(conversationId)) conversationId = 'wc-' + crypto.randomUUID(); // genera uno seguro

  const message = String(body.message ?? '').trim();
  if (!message) return res.status(400).json({ ok: false, conversationId, error: 'El mensaje está vacío.' });
  if (message.length > MAX_MSG_LEN) {
    return res.status(400).json({ ok: false, conversationId, error: 'El mensaje es demasiado largo.' });
  }

  const n = await bumpCount(conversationId);
  if (n > MAX_MSGS_POR_CONVERSACION) {
    return res.json({
      ok: true,
      conversationId,
      reply:
        'Hemos alcanzado el límite de esta conversación. Déjanos tus datos y un asesor te contactará para continuar 🙌',
    });
  }

  const st = await getState();
  const auth = st.auth ?? EMPTY_AUTH;
  try {
    const reply = await webchatTurn(conversationId, message, auth);
    return res.json({ ok: true, conversationId, reply });
  } catch (e) {
    log.error('webchatMessage error', { conversationId, err: String(e) });
    return res.status(500).json({ ok: false, conversationId, error: 'Tuvimos un inconveniente. Intenta de nuevo.' });
  }
}

/** GET /webchat — widget de chat embebible (autocontenido, sin dependencias externas). */
export function webchatPage(_req: Request, res: Response) {
  res.set('Content-Type', 'text/html; charset=utf-8').send(WIDGET_HTML);
}

const WIDGET_HTML = `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Asistente de Postgrados — Universidad Autónoma de Chile</title>
<style>
  :root{--brand:#2f6fed;--bg:#f4f6f9;--card:#fff;--ink:#1a2734;--muted:#7a8794;--line:#e6ebf1;--bot:#eef3fe}
  *{box-sizing:border-box}
  html,body{height:100%}
  body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;justify-content:center}
  .chat{display:flex;flex-direction:column;width:100%;max-width:440px;height:100dvh;background:var(--card);border-left:1px solid var(--line);border-right:1px solid var(--line)}
  header{padding:14px 16px;border-bottom:1px solid var(--line);display:flex;gap:10px;align-items:center}
  header .dot{width:9px;height:9px;border-radius:50%;background:#12b76a;flex:none}
  header h1{font-size:15px;margin:0}header .s{font-size:12px;color:var(--muted)}
  .msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
  .m{max-width:82%;padding:9px 12px;border-radius:14px;white-space:pre-wrap;word-wrap:break-word}
  .m.bot{align-self:flex-start;background:var(--bot);border-bottom-left-radius:4px}
  .m.me{align-self:flex-end;background:var(--brand);color:#fff;border-bottom-right-radius:4px}
  .m a{color:inherit}
  .typing{align-self:flex-start;color:var(--muted);font-size:13px;padding:4px 12px}
  form{display:flex;gap:8px;padding:12px;border-top:1px solid var(--line)}
  input{flex:1;border:1px solid var(--line);border-radius:10px;padding:10px 12px;font:inherit}
  input:focus{outline:2px solid var(--brand);border-color:var(--brand)}
  button{border:none;background:var(--brand);color:#fff;border-radius:10px;padding:0 16px;font:inherit;font-weight:600;cursor:pointer}
  button:disabled{opacity:.5;cursor:default}
</style></head>
<body>
<div class="chat">
  <header><span class="dot"></span><div><h1>Asistente de Postgrados</h1><div class="s">Universidad Autónoma de Chile</div></div></header>
  <div class="msgs" id="msgs"></div>
  <form id="f"><input id="t" autocomplete="off" placeholder="Escribe tu consulta…" autofocus><button id="b" type="submit">Enviar</button></form>
</div>
<script>
  var KEY='ua_webchat_cid';
  var cid=localStorage.getItem(KEY)||'';
  var msgs=document.getElementById('msgs'), form=document.getElementById('f'), input=document.getElementById('t'), btn=document.getElementById('b');
  function esc(s){return String(s==null?'':s).replace(/[&<>]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});}
  function linkify(s){return esc(s).replace(/(https?:\\/\\/[^\\s]+)/g,'<a href="$1" target="_blank" rel="noopener">$1</a>');}
  function add(text,who){var d=document.createElement('div');d.className='m '+who;d.innerHTML=linkify(text);msgs.appendChild(d);msgs.scrollTop=msgs.scrollHeight;return d;}
  function typing(on){var e=document.getElementById('ty');if(on&&!e){var d=document.createElement('div');d.id='ty';d.className='typing';d.textContent='escribiendo…';msgs.appendChild(d);msgs.scrollTop=msgs.scrollHeight;}else if(!on&&e){e.remove();}}
  add('¡Hola! Soy el asistente de Postgrados de la Universidad Autónoma de Chile. ¿En qué te puedo ayudar?','bot');
  form.addEventListener('submit',function(ev){
    ev.preventDefault();
    var text=input.value.trim(); if(!text) return;
    add(text,'me'); input.value=''; input.disabled=btn.disabled=true; typing(true);
    fetch('/webchat/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({conversationId:cid,message:text})})
      .then(function(r){return r.json();})
      .then(function(d){
        typing(false);
        if(d.conversationId){cid=d.conversationId;localStorage.setItem(KEY,cid);}
        add(d.reply||d.error||'No pude responder, intenta de nuevo.','bot');
      })
      .catch(function(){typing(false);add('Hubo un problema de conexión. Intenta de nuevo.','bot');})
      .finally(function(){input.disabled=btn.disabled=false;input.focus();});
  });
</script>
</body></html>`;
