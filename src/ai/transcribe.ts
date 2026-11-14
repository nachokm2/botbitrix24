import { config } from '../config';
import { log } from '../log';

// Transcripción de audios (voz-a-texto) con Deepgram (API pre-grabado). Los audios de WhatsApp suelen
// ser OGG/Opus; Deepgram los detecta solo. Devuelve null si no hay key, falla, o el audio viene vacío.

export type OpcionesTranscripcion = {
  /**
   * Modo internacional (core/internacional.ts): la persona habla inglés, hindi o los dos mezclados en la
   * misma frase (hinglish). Con nova-2 en español, los 5 audios de India del 14-11-2026 salieron vacíos;
   * con nova-3 multilingüe se entendieron los que tenían voz (uno en hinglish, dos en inglés).
   */
  multilingue?: boolean;
};

/** Los parámetros de Deepgram. Sin `multilingue`, los de siempre: español con el modelo configurado. */
export function parametrosDeepgram(op: OpcionesTranscripcion = {}): URLSearchParams {
  if (!op.multilingue) {
    return new URLSearchParams({
      model: config.deepgramModel || 'nova-2',
      language: 'es',
      smart_format: 'true',
      punctuate: 'true',
    });
  }
  // `multi` detecta el idioma y sigue los cambios de idioma dentro del audio. Las pistas solo inclinan la
  // detección hacia hindi e inglés: no la limitan (developers.deepgram.com/docs/multilingual-code-switching).
  const qs = new URLSearchParams({
    model: config.deepgramModelMultilingue || 'nova-3',
    language: 'multi',
    smart_format: 'true',
    punctuate: 'true',
  });
  qs.append('language_hint', 'hi');
  qs.append('language_hint', 'en');
  return qs;
}

export async function transcribeAudio(base64: string, mimeType: string, op: OpcionesTranscripcion = {}): Promise<string | null> {
  if (!config.deepgramApiKey) {
    log.warn('transcribe: sin DEEPGRAM_API_KEY (audio no transcrito)');
    return null;
  }
  try {
    const audio = Buffer.from(base64, 'base64');
    const qs = parametrosDeepgram(op);
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
    const alt = j?.results?.channels?.[0]?.alternatives?.[0];
    const transcript: string = alt?.transcript ?? '';
    const clean = transcript.trim();
    log.info('transcribe: audio transcrito', {
      chars: clean.length,
      model: qs.get('model'),
      ...(op.multilingue ? { idiomas: alt?.languages ?? null } : {}),
    });
    return clean || null;
  } catch (e) {
    log.warn('transcribe falló', { err: String(e) });
    return null;
  }
}
