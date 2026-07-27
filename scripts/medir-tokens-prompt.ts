// Mide el prefijo cacheable (system + esquemas de tools) de cada perfil con el endpoint count_tokens
// de Anthropic, y lo compara contra el mínimo cacheable del modelo (Haiku 4.096 tok, Sonnet 2.048 tok).
// Sirve para confirmar si la caché de prompt (agentLoop.ts → cachedSystem) realmente aplica por canal.
// Uso:  REDIS_URL= DATABASE_URL= npx tsx scripts/medir-tokens-prompt.ts   (o vía `railway run` para el env)
import { anthropic } from '../src/ai/client';
import { tools } from '../src/ai/tools';
import { VOICE_PROFILE, WHATSAPP_PROFILE, type ChannelProfile } from '../src/core/channel';
import { VOICE_OUTBOUND_MMD } from '../src/campaign/prompt.mmd';

// Mínimo cacheable por modelo (tokens): por debajo de esto, cache_control no cachea (silencioso, no falla).
function minCacheable(model: string): number {
  if (/haiku/i.test(model)) return 4096;
  if (/sonnet/i.test(model)) return 2048;
  return 1024; // Opus u otros
}

async function count(model: string, system: string, withTools: any[]): Promise<number> {
  const r: any = await anthropic.messages.countTokens({
    model,
    system,
    tools: withTools as any,
    messages: [{ role: 'user', content: 'hola' }],
  } as any);
  return r.input_tokens;
}

async function medir(p: ChannelProfile) {
  const allowed = tools.filter((t) => p.toolNames.includes(t.name));
  const soloSystem = await count(p.model, p.systemPrompt, []);
  const systemMasTools = await count(p.model, p.systemPrompt, allowed);
  const min = minCacheable(p.model);
  // El prefijo cacheable ≈ system+tools menos el turno mínimo 'hola' (~8 tok). Usamos systemMasTools
  // como cota superior conservadora del prefijo (si ESTE supera el mínimo, la caché aplica de sobra).
  const cachea = systemMasTools >= min;
  return {
    label: p.label,
    model: p.model,
    nTools: allowed.length,
    soloSystem,
    tools: systemMasTools - soloSystem,
    prefijo: systemMasTools,
    min,
    cachea,
  };
}

(async () => {
  const perfiles = [VOICE_OUTBOUND_MMD, VOICE_PROFILE, WHATSAPP_PROFILE];
  const rows = [];
  for (const p of perfiles) rows.push(await medir(p));

  const pad = (s: any, n: number) => String(s).padEnd(n);
  const padN = (s: any, n: number) => String(s).padStart(n);
  console.log('\n  Prefijo cacheable (system + tools) medido con count_tokens de Anthropic');
  console.log('  ' + '─'.repeat(92));
  console.log(
    '  ' + pad('Perfil', 40) + pad('Modelo', 20) + padN('system', 8) + padN('tools', 8) + padN('prefijo', 9) + '  ¿cachea?',
  );
  console.log('  ' + '─'.repeat(92));
  for (const r of rows) {
    const veredicto = r.cachea
      ? `SÍ (min ${r.min})`
      : `NO — faltan ${r.min - r.prefijo} tok (min ${r.min})`;
    console.log(
      '  ' +
        pad(r.label, 40) +
        pad(r.model + ` (${r.nTools}t)`, 20) +
        padN(r.soloSystem, 8) +
        padN(r.tools, 8) +
        padN(r.prefijo, 9) +
        '  ' +
        veredicto,
    );
  }
  console.log('  ' + '─'.repeat(92));
  console.log('  Nota: el prefijo incluye ~8 tok del turno mínimo "hola"; el prefijo real es ~esa cifra menos ~8.\n');
})().catch((e) => {
  console.error('ERROR:', e?.message || e);
  process.exit(1);
});
