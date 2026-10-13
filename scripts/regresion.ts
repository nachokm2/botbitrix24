/**
 * Corre la suite de regresión contra el bot DE VERDAD (modelo real, catálogo real, planilla real).
 *
 *   npm run regresion                              → la marca que esté configurada en MARCA
 *   MARCA=carver npm run regresion
 *   MARCA=carver REGRESION_CONJUNTO=referencia REGRESION_SALIDA=out.json npm run regresion
 *
 * No va en `npm test` a propósito: llama al modelo, así que cuesta dinero, tarda y puede variar
 * entre corridas. Es la comprobación que se hace ANTES de tocar el prompt y DESPUÉS, para ver si
 * algo se rompió. El motor y sus comprobaciones sí están cubiertos por test/regresion.test.ts.
 *
 * El CRM se reemplaza por un doble: esto no debe crear leads ni derivar nada a nadie de verdad.
 * El aislamiento (sin Redis, Postgres, Bitrix ni WhatsApp) lo impone aislar-regresion.ts, que tiene
 * que ser el PRIMER import.
 */
import './aislar-regresion';
import { writeFileSync } from 'node:fs';
import { runAgentTurn } from '../src/ai/agentLoop';
import { executeTool } from '../src/ai/toolRunner';
import { WHATSAPP_PROFILE } from '../src/core/channel';
import { config } from '../src/config';
import { ejecutarCaso, informe, metricas, type LlamadaHerramienta } from '../src/ai/regresion';
import { casosDeMarca, CASOS_REFERENCIA_CARVER } from '../src/ai/regresion.casos';
import { marca } from '../src/marca';

// Herramientas que solo LEEN datos locales o públicos: se ejecutan de verdad, porque son el dato que
// se está comprobando. Todo lo que escribe en el CRM se simula.
const SOLO_LECTURA = new Set([
  'consultar_programas',
  'detalle_programa',
  'consultar_condiciones_comerciales',
  'obtener_brochure',
  'consultar_informacion_institucional',
]);
const ESCRIBEN_EN_CRM = new Set(['registrar_interes_crm', 'escalar_a_humano', 'registrar_documento_identidad']);

async function main() {
  if (config.databaseUrl || config.redisUrl) {
    throw new Error('La regresión no debe correr con Redis/Postgres configurados (ver aislar-regresion.ts).');
  }
  const conjunto = process.env.REGRESION_CONJUNTO ?? 'todos';
  // REGRESION_CASOS="R11,R05" corre solo los casos cuyo nombre contenga alguno de esos textos.
  const filtro = (process.env.REGRESION_CASOS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const casos = (conjunto === 'referencia' ? CASOS_REFERENCIA_CARVER : casosDeMarca(marca.key)).filter(
    (c) => !filtro.length || filtro.some((f) => c.nombre.includes(f)),
  );
  console.log(`Regresión · marca ${marca.key} · modelo ${config.model} · ${casos.length} casos (${conjunto})\n`);

  const resultados = [];
  for (const caso of casos) {
    const tools: LlamadaHerramienta[] = [];
    // Un id distinto por caso: comparten proceso, y si compartieran historial el segundo caso
    // arrancaría con el contexto del primero y las comprobaciones dejarían de significar nada.
    const conversationId = `regresion-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const cx = caso.contexto ?? {};
    const ctx: any = {
      auth: { domain: '', access_token: '' },
      conversationId,
      botId: 0,
      crmEntities: {},
      crmEntity: null,
      profile: WHATSAPP_PROFILE,
      identidadAsesor: cx.identidadAsesor ?? null,
      datosConocidos: cx.datosConocidos ?? null,
    };

    const r = await ejecutarCaso(caso, async (mensaje) => {
      const antes = tools.length;
      ctx.ultimoMensajeCliente = mensaje;
      const respuesta = await runAgentTurn(ctx, mensaje, '', async (name, input) => {
        let resultado: any;
        if (SOLO_LECTURA.has(name)) resultado = await executeTool(name, input, ctx);
        else if (name === 'consultar_estado_estudiante') resultado = cx.estudiante ?? { ok: true, matriculado: false };
        else if (ESCRIBEN_EN_CRM.has(name) && cx.crmCaido) {
          resultado = { ok: false, error: 'BITRIX_NO_DISPONIBLE', mensaje: 'El CRM no respondió (simulado).' };
        } else if (name === 'escalar_a_humano') {
          resultado = { ok: true, escalado: true, asesor: null, mensaje: 'Conversación derivada (simulado).' };
        } else resultado = { ok: true, simulado: true };
        tools.push({ name, input, resultado });
        return resultado;
      });
      return { respuesta, tools: tools.slice(antes) };
    });

    resultados.push(r);
    console.log(`${r.ok ? '✓' : '✗'} ${r.nombre}`);
    for (const f of r.fallas) console.log(`   · ${f}`);
  }

  const m = metricas(resultados);
  console.log('\n' + informe(resultados));
  console.log('\nMétricas:', JSON.stringify(m, null, 2));
  if (process.env.REGRESION_SALIDA) {
    writeFileSync(
      process.env.REGRESION_SALIDA,
      JSON.stringify({ fecha: new Date().toISOString(), marca: marca.key, modelo: config.model, conjunto, metricas: m, resultados }, null, 2),
    );
    console.log(`Informe completo en ${process.env.REGRESION_SALIDA}`);
  }
  process.exit(resultados.every((r) => r.ok) ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
