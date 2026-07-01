/**
 * Escenario VoxEngine (Voximplant) — Agente de voz UA Postgrados (Fase 2, PoC).
 *
 * ESTE ARCHIVO NO CORRE EN NUESTRO BACKEND: se pega/despliega en la plataforma
 * Voximplant (manage.voximplant.com → Applications → Scenarios). Está aquí solo
 * para versionarlo junto al proyecto.
 *
 * Pipeline: ASR (Voximplant, Google es_CL) → texto → HTTP a nuestro backend (Claude)
 *           → texto → TTS (Voximplant, Microsoft es_CL Neural) → llamada.
 * Barge-in: se corta el TTS cuando el ASR detecta que el usuario empieza a hablar.
 *
 * Config: reemplaza BACKEND_BASE y las constantes. Para llamadas SALIENTES, el
 * escenario se lanza con la HTTP API StartScenarios pasando script_custom_data
 * con el número a marcar (JSON.parse(VoxEngine.customData())).
 *
 * Doc de referencia:
 *  - ASR:   https://voximplant.com/docs/references/voxengine/voxengine/createasr
 *  - TTS:   https://voximplant.com/docs/references/voxengine/voxengine/createttsplayer
 *  - HTTP:  https://voximplant.com/docs/references/voxengine/net/httprequestasync
 *  - Fwd:   https://voximplant.com/docs/references/voxengine/voxengine/forwardcalltopstn
 */

require(Modules.ASR);

const BACKEND_BASE = 'https://botbitrix24-production.up.railway.app'; // ← tu backend
const VOICE_SECRET = 'PON_AQUI_EL_MISMO_VOICE_SHARED_SECRET';         // ← igual a VOICE_SHARED_SECRET en Railway
const CALLER_ID = '56221234567';                                     // ← número real/verificado en Voximplant (para salientes/desvíos)

const ASR_PROFILE = ASRProfileList.Google.es_CL;                      // STT español de Chile
const TTS_VOICE = VoiceList.Microsoft.Neural.es_CL_CatalinaNeural;    // TTS es-CL nativo

let call, asr, ttsPlayer, callId;
let speaking = false;

VoxEngine.addEventListener(AppEvents.CallAlerting, async (e) => {
  call = e.call;

  // ¿Saliente? El número a marcar viaja en customData (StartScenarios script_custom_data).
  let outboundTo = null;
  try { outboundTo = JSON.parse(VoxEngine.customData() || '{}').to || null; } catch (_) {}

  if (outboundTo) {
    call = VoxEngine.callPSTN(outboundTo, CALLER_ID);
    call.addEventListener(CallEvents.Connected, () => onConnected({ phone: outboundTo, type: 1 }));
    call.addEventListener(CallEvents.Failed, () => VoxEngine.terminate());
  } else {
    call.answer();
    call.addEventListener(CallEvents.Connected, () => onConnected({ phone: e.callerid, type: 2 }));
  }

  call.addEventListener(CallEvents.Disconnected, onDisconnected);
});

async function onConnected({ phone, type }) {
  // 1) Registrar la llamada en Bitrix y abrir la sesión de voz.
  const reg = await post('/voice/call/register', { phone, type });
  callId = reg.callId;

  // 2) Saludo inicial (TTS) y arranque del ASR continuo.
  say(reg.saludo || 'Hola, ¿en qué le puedo ayudar?');
  startASR();
}

function startASR() {
  asr = VoxEngine.createASR({ profile: ASR_PROFILE, interimResults: true });
  call.sendMediaTo(asr);

  // Barge-in: si el usuario empieza a hablar mientras el bot habla, cortamos el TTS.
  asr.addEventListener(ASREvents.CaptureStarted, () => stopSpeaking());

  // Resultado final de una frase → lo mandamos al backend (Claude).
  asr.addEventListener(ASREvents.Result, async (ev) => {
    const text = (ev.text || '').trim();
    if (!text) return;
    const turn = await post('/voice/turn', { callId, text });
    if (!turn || !turn.ok) return;

    if (turn.action === 'transfer') {
      say(turn.reply);
      const destino = turn.transferTo && turn.transferTo.destino;
      // Desvío a humano: a un número PSTN (o SIP con forwardCallToSIP).
      if (destino) {
        const human = VoxEngine.callPSTN(destino, CALLER_ID);
        VoxEngine.sendMediaBetween(call, human);
      } else {
        say('En breve un asesor se comunicará con usted. ¡Que tenga buen día!');
        endCall();
      }
      return;
    }

    say(turn.reply);
    if (turn.action === 'end') endCall();
  });
}

function say(text) {
  if (!text) return;
  stopSpeaking();
  ttsPlayer = VoxEngine.createTTSPlayer(String(text), { voice: TTS_VOICE, progressivePlayback: true });
  ttsPlayer.sendMediaTo(call);
  speaking = true;
  ttsPlayer.addEventListener(PlayerEvents.PlaybackFinished, () => { speaking = false; });
}

function stopSpeaking() {
  if (ttsPlayer && speaking) { try { ttsPlayer.stop(); } catch (_) {} }
  speaking = false;
}

function endCall() {
  // Deja que termine el último TTS y cuelga.
  if (ttsPlayer) ttsPlayer.addEventListener(PlayerEvents.PlaybackFinished, () => VoxEngine.terminate());
  else VoxEngine.terminate();
}

async function onDisconnected(e) {
  const duration = (e && e.duration) || 0;
  await post('/voice/call/finish', { callId, duration });
  VoxEngine.terminate();
}

// Helper HTTP a nuestro backend.
async function post(path, body) {
  try {
    const res = await Net.httpRequestAsync(BACKEND_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-voice-secret': VOICE_SECRET },
      postData: JSON.stringify(body),
      timeout: 30,
    });
    return JSON.parse(res.text || '{}');
  } catch (err) {
    Logger.write('backend error: ' + err);
    return { ok: false };
  }
}
