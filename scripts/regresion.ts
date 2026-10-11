/**
 * Corre la suite de regresión contra el bot DE VERDAD (modelo real, catálogo real, planilla real).
 *
 *   npm run regresion            → la marca que esté configurada en MARCA
 *   MARCA=carver npm run regresion
 *
 * No va en `npm test` a propósito: llama al modelo, así que cuesta dinero, tarda y puede variar
 * entre corridas. Es la comprobación que se hace ANTES de tocar el prompt y DESPUÉS, para ver si
 * algo se rompió. El motor y sus comprobaciones sí están cubiertos por test/regresion.test.ts.
 *
 * El CRM se reemplaza por un doble: esto no debe crear leads ni derivar nada a nadie de verdad.
 */
process.env.REDIS_URL = process.env.REDIS_URL ?? ''; // historial en memoria: cada caso parte limpio

import { runAgentTurn } from '../src/ai/agentLoop';
import { executeTool } from '../src/ai/toolRunner';
import { WHATSAPP_PROFILE } from '../src/core/channel';
import { ejecutarCaso, informe, type LlamadaHerramienta } from '../src/ai/regresion';
import { casosDeMarca } from '../src/ai/regresion.casos';
import { marca } from '../src/marca';

const SOLO_LECTURA = new Set(['consultar_programas', 'detalle_programa', 'consultar_condiciones_comerciales']);

async function main() {
  const casos = casosDeMarca(marca.key);
  console.log(`Regresión · marca ${marca.key} · ${casos.length} casos\n`);

  const resultados = [];
  for (const caso of casos) {
    const tools: LlamadaHerramienta[] = [];
    // Un id distinto por caso: comparten proceso, y si compartieran historial el segundo caso
    // arrancaría con el contexto del primero y las comprobaciones dejarían de significar nada.
    const conversationId = `regresion-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ctx: any = {
      auth: { domain: '', access_token: '' },
      conversationId,
      botId: 0,
      crmEntities: {},
      crmEntity: null,
      profile: WHATSAPP_PROFILE,
    };

    const r = await ejecutarCaso(caso, async (mensaje) => {
      const antes = tools.length;
      const respuesta = await runAgentTurn(ctx, mensaje, '', async (name, input) => {
        tools.push({ name, input });
        // Las de catálogo/planilla se ejecutan de verdad: son el dato que se está comprobando.
        // Las que escriben se simulan, para no tocar el CRM desde una corrida de pruebas.
        if (SOLO_LECTURA.has(name)) return executeTool(name, input, ctx);
        if (name === 'escalar_a_humano') {
          return { ok: true, escalado: true, asesor: null, mensaje: 'Conversación derivada (simulado).' };
        }
        return { ok: true, simulado: true };
      });
      return { respuesta, tools: tools.slice(antes) };
    });

    resultados.push(r);
    console.log(`${r.ok ? '✓' : '✗'} ${r.nombre}`);
    for (const f of r.fallas) console.log(`   · ${f}`);
  }

  console.log('\n' + informe(resultados));
  process.exit(resultados.every((r) => r.ok) ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
