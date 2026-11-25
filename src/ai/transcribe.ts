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
  /** Un solo idioma (código de Deepgram, por ejemplo «te»), con nova-3. Para el segundo intento. */
  idioma?: string;
};

/** Los parámetros de Deepgram. Sin `multilingue`, los de siempre: español con el modelo configurado. */
export function parametrosDeepgram(op: OpcionesTranscripcion = {}): URLSearchParams {
  if (op.idioma) {
    return new URLSearchParams({
      model: config.deepgramModelMultilingue || 'nova-3',
      language: op.idioma,
      smart_format: 'true',
      punctuate: 'true',
    });
  }
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

type Resultado = { texto: string; confianza: number; palabras: number; duracion: number | null; idiomas: unknown; bytes: number };

async function pedirTranscripcion(audio: Buffer, mimeType: string, qs: URLSearchParams): Promise<Resultado | null> {
  const r = await fetch(`https://api.deepgram.com/v1/listen?${qs.toString()}`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${config.deepgramApiKey}`,
      'Content-Type': mimeType || 'audio/ogg',
    },
    body: audio as unknown as BodyInit,
  });
  if (!r.ok) {
    log.warn('transcribe: Deepgram error', { status: r.status, language: qs.get('language'), body: (await r.text()).slice(0, 300) });
    return null;
  }
  const j: any = await r.json();
  const alt = j?.results?.channels?.[0]?.alternatives?.[0];
  const texto = String(alt?.transcript ?? '').trim();
  const duracion = Number(j?.metadata?.duration);
  return {
    texto,
    confianza: Number(alt?.confidence) || 0,
    palabras: Array.isArray(alt?.words) ? alt.words.length : texto.split(/\s+/).filter(Boolean).length,
    duracion: Number.isFinite(duracion) ? duracion : null,
    idiomas: alt?.languages ?? null,
    bytes: audio.length,
  };
}

/** Un audio de menos de esto no es un mensaje: no se reintenta (suele ser un toque o un ruido). */
const SEGUNDOS_MINIMOS_PARA_REINTENTAR = 2;
/** El segundo intento solo se acepta con esta confianza y al menos tantas palabras: con un idioma equivocado,
 *  Deepgram devuelve texto suelto con confianza baja, y es mejor pedir que lo escriban a contestar a eso. */
const CONFIANZA_MINIMA_REINTENTO = 0.85;
const PALABRAS_MINIMAS_REINTENTO = 4;

/**
 * Transcribe un audio. En el modo internacional, si el modelo multilingüe no saca nada de un audio que sí
 * dura (del 16 al 25-11-2026, 44 de 113 audios de WhatsApp salieron vacíos; hay muchas lenguas de India que
 * `multi` puede no reconocer), se prueba cada idioma de respaldo por separado (DEEPGRAM_IDIOMAS_RESPALDO)
 * y se queda con el de mayor confianza.
 */
export async function transcribeAudio(base64: string, mimeType: string, op: OpcionesTranscripcion = {}): Promise<string | null> {
  if (!config.deepgramApiKey) {
    log.warn('transcribe: sin DEEPGRAM_API_KEY (audio no transcrito)');
    return null;
  }
  try {
    const audio = Buffer.from(base64, 'base64');
    const qs = parametrosDeepgram(op);
    const primero = await pedirTranscripcion(audio, mimeType, qs);
    if (!primero) return null;
    log.info('transcribe: audio transcrito', {
      chars: primero.texto.length,
      model: qs.get('model'),
      ...(op.multilingue ? { idiomas: primero.idiomas, segundos: primero.duracion, bytes: primero.bytes } : {}),
    });
    if (primero.texto) return primero.texto;

    const idiomas = op.multilingue ? config.deepgramIdiomasRespaldo : [];
    if (!idiomas.length || (primero.duracion ?? 0) < SEGUNDOS_MINIMOS_PARA_REINTENTAR) return null;
    const intentos = await Promise.all(
      idiomas.map((idioma) =>
        pedirTranscripcion(audio, mimeType, parametrosDeepgram({ idioma }))
          .then((r) => (r ? { idioma, ...r } : null))
          .catch(() => null),
      ),
    );
    const buenos = intentos
      .filter((x): x is NonNullable<typeof x> => !!x && !!x.texto && x.confianza >= CONFIANZA_MINIMA_REINTENTO && x.palabras >= PALABRAS_MINIMAS_REINTENTO)
      .sort((a, b) => b.confianza - a.confianza);
    log.info('transcribe: segundo intento por idioma', {
      segundos: primero.duracion,
      probados: idiomas.join(','),
      conTexto: intentos.filter((x) => x?.texto).map((x) => `${x!.idioma}:${x!.confianza.toFixed(2)}`).join(','),
      elegido: buenos[0]?.idioma ?? null,
    });
    return buenos[0]?.texto ?? null;
  } catch (e) {
    log.warn('transcribe falló', { err: String(e) });
    return null;
  }
}
