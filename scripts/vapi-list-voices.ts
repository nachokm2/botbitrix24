import { config } from '../src/config';

// Lista voces de ElevenLabs disponibles en Vapi y resalta las de español (para elegir voiceId).
// Uso: railway run -- npx tsx scripts/vapi-list-voices.ts
async function main() {
  if (!config.vapiApiKey) throw new Error('Falta VAPI_API_KEY en el entorno.');
  const provider = process.argv[2] || '11labs';
  const urls = [
    `https://api.vapi.ai/voice-library?provider=${provider}`,
    `https://api.vapi.ai/voice-library/${provider}`,
  ];
  let list: any[] = [];
  for (const url of urls) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${config.vapiApiKey}` } });
    const json: any = await r.json().catch(() => null);
    if (r.ok && json) {
      list = Array.isArray(json) ? json : (json.results ?? json.voices ?? json.data ?? []);
      if (list.length) { console.log('Fuente:', url, '· total:', list.length); break; }
    } else {
      console.log('(', url, '→', r.status, ')');
    }
  }
  if (!list.length) {
    console.log('No pude listar voces (revisa el endpoint). Respuesta vacía.');
    return;
  }
  const txt = (v: any) => JSON.stringify(v).toLowerCase();
  const es = list.filter((v) => /spanish|espa[nñ]|"es|es-|latin|castellano|mexic|argent|colomb|chil/.test(txt(v)));
  const pick = (v: any) => ({
    name: v.name ?? v.voiceName ?? v.slug,
    voiceId: v.voiceId ?? v.id ?? v.providerId ?? v.publicId,
    gender: v.gender ?? v.labels?.gender,
    accent: v.accent ?? v.labels?.accent ?? v.labels?.language ?? v.language,
    desc: v.description ?? v.labels?.description,
  });
  console.log('\n=== VOCES EN ESPAÑOL (', es.length, ') ===');
  console.log(JSON.stringify((es.length ? es : list).slice(0, 40).map(pick), null, 2));
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
