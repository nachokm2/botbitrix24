/**
 * Vuelve a evaluar una corrida GUARDADA de la suite de regresión con las comprobaciones actuales,
 * sin llamar al modelo: reproduce las respuestas y herramientas registradas en el JSON.
 *
 *   npx tsx scripts/reevaluar-regresion.ts <corrida.json> [salida.json]
 *
 * Sirve para comparar "antes" y "después" con EXACTAMENTE las mismas reglas aunque las comprobaciones
 * se hayan endurecido después de la primera corrida.
 */
import './aislar-regresion';
import { readFileSync, writeFileSync } from 'node:fs';
import { ejecutarCaso, informe, metricas } from '../src/ai/regresion';
import { CASOS_REFERENCIA_CARVER } from '../src/ai/regresion.casos';

const [entrada, salida] = process.argv.slice(2);
if (!entrada) throw new Error('Uso: reevaluar-regresion.ts <corrida.json> [salida.json]');
const corrida = JSON.parse(readFileSync(entrada, 'utf8'));

async function main() {
  const resultados = [];
  for (const caso of CASOS_REFERENCIA_CARVER) {
    const previo = corrida.resultados.find((r: any) => r.nombre === caso.nombre);
    if (!previo) continue;
    let i = 0;
    resultados.push(
      await ejecutarCaso(caso, async () => {
        const t = previo.turnos[i++] ?? { respuesta: '', tools: [] };
        return { respuesta: t.respuesta, tools: t.tools };
      }),
    );
  }
  console.log(informe(resultados));
  const m = metricas(resultados);
  console.log('\nMétricas:', JSON.stringify(m, null, 2));
  if (salida) writeFileSync(salida, JSON.stringify({ origen: entrada, metricas: m, resultados }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
