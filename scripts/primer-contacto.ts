/**
 * Muestra a quiénes se les escribiría un primer contacto, SIN escribirle a nadie.
 *
 *   npm run primer-contacto          → últimos 7 días
 *   npm run primer-contacto -- 30    → últimos 30 días
 *
 * Es material para decidir si se enciende (PRIMER_CONTACTO_ACTIVO), no una herramienta de envío.
 * Para enviar de verdad hace falta además una plantilla aprobada por Meta: fuera de las 24 horas de
 * la última interacción, WhatsApp no deja mandar texto libre.
 */
import { correrPrimerContacto } from '../src/crm/primerContacto';
import { initDb, dbEnabled } from '../src/store/db';
import { getState } from '../src/store';
import { config } from '../src/config';
import { marca } from '../src/marca';

async function main() {
  const dias = Number(process.argv[2] ?? config.primerContactoDias) || config.primerContactoDias;
  // Sin esto el pool queda sin abrir (initDb solo corre en el servidor) y el cruce contra las
  // conversaciones del bot devuelve vacío: el número saldría inflado sin que nada lo advirtiera.
  await initDb();
  const st = await getState();
  if (!st.auth) {
    console.error('Sin auth de Bitrix: instala la aplicación o define el token antes de correr esto.');
    process.exit(1);
  }

  const r = await correrPrimerContacto(st.auth, { dias, simular: true });

  console.log(`\nPrimer contacto · marca ${marca.key} · últimos ${dias} días\n`);
  console.log(`Negociaciones con teléfono y SIN conversación del bot: ${r.candidatos}`);
  if (!dbEnabled()) {
    // Sin la base, el cruce contra las conversaciones del bot no se puede hacer y el número sale
    // inflado: hay que correr esto con DATABASE_URL apuntando a la base de producción.
    console.log('  (sin Postgres: no se pudo descontar a quienes el bot YA atendió)');
  }
  if (config.primerContactoCategorias.length) {
    console.log(`Embudos considerados: ${config.primerContactoCategorias.join(', ')}`);
  } else {
    console.log('Embudos considerados: todos (PRIMER_CONTACTO_CATEGORIAS sin definir)');
  }
  console.log(`Envío real: ${config.primerContactoActivo ? 'ACTIVO' : 'apagado (PRIMER_CONTACTO_ACTIVO)'}`);
  console.log(`Plantilla: ${config.primerContactoPlantilla || '(ninguna configurada)'}`);
  console.log(`Tope diario: ${config.primerContactoMaxDiario}`);

  if (r.muestra.length) {
    console.log('\nPrimeros candidatos:');
    for (const c of r.muestra) {
      const tel = c.telefono.slice(0, -4) + '····'; // no hace falta imprimir el número completo
      console.log(`  deal#${c.dealId}  ${(c.nombre || '(sin nombre)').padEnd(24)} ${tel}  ${c.programa.slice(0, 50)}`);
    }
  }
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
