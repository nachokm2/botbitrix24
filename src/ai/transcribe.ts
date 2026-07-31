import { config } from '../config';
import { log } from '../log';

// Transcripción de audios (voz-a-texto) con Deepgram (API pre-grabado). Los audios de WhatsApp suelen
// ser OGG/Opus; Deepgram los detecta solo. Devuelve null si no hay key, falla, o el audio viene vacío.

export async function transcribeAudio(base64: string, mimeType: string): Promise<string | null> {
  if (!config.deepgramApiKey) {
    log.warn('transcribe: sin DEEPGRAM_API_KEY (audio no transcrito)');
    return null;
  }
  try {
    const audio = Buffer.from(base64, 'base64');
    const qs = new URLSearchParams({
      model: config.deepgramModel || 'nova-2',
      language: 'es',
      smart_format: 'true',
      punctuate: 'true',
    });
    const r = await fetch(`https://api.deepgram.com/v1/listen?${qs.toString()}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${config.deepgramApiKey}`,
        'Content-Type': mimeType || 'audio/ogg',
      },
      body: audio,
    });
    if (!r.ok) {
      log.warn('transcribe: Deepgram error', { status: r.status, body: (await r.text()).slice(0, 300) });
      return null;
    }
    const j: any = await r.json();
    const transcript: string = j?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
    const clean = transcript.trim();
    log.info('transcribe: audio transcrito', { chars: clean.length, model: config.deepgramModel });
    return clean || null;
  } catch (e) {
    log.warn('transcribe falló', { err: String(e) });
    return null;
  }
}
