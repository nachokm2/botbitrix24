import { test } from 'node:test';
import assert from 'node:assert/strict';

// Motor de la suite de regresión. La suite completa (scripts/regresion.ts) llama al modelo de
// verdad, así que no corre acá; lo que sí tiene que estar cubierto es el motor: una comprobación que
// no detecta lo que dice detectar es peor que no tenerla, porque da confianza falsa.
process.env.REDIS_URL = '';
process.env.NODE_ENV = 'test';

const { ejecutarCaso, informe } = await import('../src/ai/regresion');
const { casosDeMarca, CASOS_COMUNES } = await import('../src/ai/regresion.casos');

/** Doble del bot: devuelve respuestas fijas y las herramientas que se le indiquen. */
function bot(guion: Array<{ respuesta: string; tools?: Array<{ name: string; input?: any }> }>) {
  let i = 0;
  return async () => {
    const t = guion[Math.min(i++, guion.length - 1)];
    return { respuesta: t.respuesta, tools: t.tools ?? [] };
  };
}

const caso = (comprobaciones: any[], mensajes = ['hola']) => ({ nombre: 'caso', mensajes, comprobaciones });

test('no_pide_dato detecta que el bot volvió a pedir el nombre', async () => {
  const r = await ejecutarCaso(
    caso([{ tipo: 'no_pide_dato', dato: 'nombre' }]),
    bot([{ respuesta: 'Claro, ¿cuál es tu nombre?' }]),
  );
  assert.equal(r.ok, false);
  assert.match(r.fallas[0], /volvió a pedir nombre/);
});

test('no_pide_dato no se dispara cuando el bot solo usa el nombre', async () => {
  const r = await ejecutarCaso(
    caso([{ tipo: 'no_pide_dato', dato: 'nombre' }]),
    bot([{ respuesta: 'Gracias, Camila. Te cuento del programa.' }]),
  );
  assert.equal(r.ok, true, r.fallas.join('; '));
});

test('no_pide_dato ignora tildes y mayúsculas', async () => {
  const r = await ejecutarCaso(
    caso([{ tipo: 'no_pide_dato', dato: 'telefono' }]),
    bot([{ respuesta: '¿Me facilitas tu Teléfono?' }]),
  );
  assert.equal(r.ok, false);
});

test('precio_viene_de_la_planilla acepta un precio consultado', async () => {
  const r = await ejecutarCaso(
    caso([{ tipo: 'precio_viene_de_la_planilla' }], ['cuánto vale']),
    bot([{ respuesta: 'El arancel es $3.500.000.', tools: [{ name: 'consultar_condiciones_comerciales', input: { programa: 'x' } }] }]),
  );
  assert.equal(r.ok, true, r.fallas.join('; '));
});

test('precio_viene_de_la_planilla rechaza un precio inventado', async () => {
  const r = await ejecutarCaso(
    caso([{ tipo: 'precio_viene_de_la_planilla' }], ['cuánto vale']),
    bot([{ respuesta: 'El arancel es $3.500.000.' }]),
  );
  assert.equal(r.ok, false);
  assert.match(r.fallas[0], /sin consultar la planilla/);
});

test('precio_viene_de_la_planilla mira el ORDEN, no si la herramienta se llamó alguna vez', async () => {
  // Un precio en el turno 1 y la consulta recién en el 2 es exactamente el caso que hay que atrapar.
  const r = await ejecutarCaso(
    { nombre: 'c', mensajes: ['a', 'b'], comprobaciones: [{ tipo: 'precio_viene_de_la_planilla' }] },
    bot([
      { respuesta: 'Cuesta $2.000.000 aproximadamente.' },
      { respuesta: 'Confirmado: $2.100.000.', tools: [{ name: 'consultar_condiciones_comerciales' }] },
    ]),
  );
  assert.equal(r.ok, false);
});

test('deriva y no_deriva se apoyan en la herramienta, no en lo que el bot dice', async () => {
  const conTool = bot([{ respuesta: 'Listo', tools: [{ name: 'escalar_a_humano' }] }]);
  assert.equal((await ejecutarCaso(caso([{ tipo: 'deriva' }]), conTool)).ok, true);
  assert.equal((await ejecutarCaso(caso([{ tipo: 'no_deriva' }]), conTool)).ok, false);

  const sinTool = bot([{ respuesta: 'Un asesor te contactará a la brevedad.' }]);
  assert.equal((await ejecutarCaso(caso([{ tipo: 'deriva' }]), sinTool)).ok, false, 'decirlo no es hacerlo');
});

test('programa_de_interes acepta el que se registró explícitamente', async () => {
  const r = await ejecutarCaso(
    caso([{ tipo: 'programa_de_interes', programa: 'psicolog' }]),
    bot([{ respuesta: 'Te cuento', tools: [{ name: 'registrar_interes_crm', input: { programa_interes: 'Magíster en Psicología Clínica' } }] }]),
  );
  assert.equal(r.ok, true, r.fallas.join('; '));
});

test('programa_de_interes acepta también el camino de pedir el precio', async () => {
  // Consultar el precio de un programa concreto lo fija como programa de interés sin pasar por
  // registrar_interes_crm (ver seguirProgramaDeInteres en ai/toolRunner.ts).
  const r = await ejecutarCaso(
    caso([{ tipo: 'programa_de_interes', programa: 'psicolog' }]),
    bot([{ respuesta: 'Te cuento', tools: [{ name: 'consultar_condiciones_comerciales', input: { programa: 'Magíster en Psicología' } }] }]),
  );
  assert.equal(r.ok, true, r.fallas.join('; '));
});

test('programa_de_interes mira el ÚLTIMO: el defecto era quedarse con el primero', async () => {
  const r = await ejecutarCaso(
    { nombre: 'c', mensajes: ['a', 'b'], comprobaciones: [{ tipo: 'programa_de_interes', programa: 'psicolog' }] },
    bot([
      { respuesta: 'ok', tools: [{ name: 'registrar_interes_crm', input: { programa_interes: 'Magíster en Psicología' } }] },
      { respuesta: 'ok', tools: [{ name: 'detalle_programa', input: { nombre: 'Magíster en Educación' } }] },
    ]),
  );
  assert.equal(r.ok, false, 'la conversación terminó en Educación: esa es la ficha correcta');
  assert.match(r.fallas[0], /se quedó con "Magíster en Educación"/);
});

test('programa_de_interes falla si nunca se fijó ninguno', async () => {
  const r = await ejecutarCaso(
    caso([{ tipo: 'programa_de_interes', programa: 'psicolog' }]),
    bot([{ respuesta: 'ok', tools: [{ name: 'consultar_programas', input: { tipo: 'magister' } }] }]),
  );
  assert.equal(r.ok, false);
  assert.match(r.fallas[0], /nunca fijó/);
});

test('largo_maximo detecta el muro de texto', async () => {
  const r = await ejecutarCaso(caso([{ tipo: 'largo_maximo', caracteres: 100 }]), bot([{ respuesta: 'x'.repeat(200) }]));
  assert.equal(r.ok, false);
  assert.match(r.fallas[0], /200 caracteres/);
});

test('no_ofrece_llamada detecta el ofrecimiento aunque esté conjugado distinto', async () => {
  for (const frase of ['Te llamo mañana', '¿Coordinamos una llamada?', 'Prefiero llamarte']) {
    const r = await ejecutarCaso(caso([{ tipo: 'no_ofrece_llamada' }]), bot([{ respuesta: frase }]));
    assert.equal(r.ok, false, `no detectó: ${frase}`);
  }
});

test('no_ofrece_llamada no se dispara porque el cliente mencione el teléfono', async () => {
  const r = await ejecutarCaso(
    caso([{ tipo: 'no_ofrece_llamada' }]),
    bot([{ respuesta: 'Perfecto, te escribo por acá con toda la información.' }]),
  );
  assert.equal(r.ok, true, r.fallas.join('; '));
});

test('no_respuesta_vacia atrapa el turno vacío', async () => {
  const r = await ejecutarCaso(caso([{ tipo: 'no_respuesta_vacia' }]), bot([{ respuesta: '   ' }]));
  assert.equal(r.ok, false);
});

test('ejecuta los mensajes en orden y conserva la transcripción', async () => {
  const r = await ejecutarCaso(
    { nombre: 'c', mensajes: ['uno', 'dos'], comprobaciones: [] },
    bot([{ respuesta: 'r1' }, { respuesta: 'r2' }]),
  );
  assert.deepEqual(r.turnos.map((t) => t.mensaje), ['uno', 'dos']);
  assert.deepEqual(r.turnos.map((t) => t.respuesta), ['r1', 'r2']);
});

test('el informe resume cuántos pasaron y detalla solo los que fallaron', async () => {
  const ok = await ejecutarCaso(caso([]), bot([{ respuesta: 'bien' }]));
  const mal = await ejecutarCaso(caso([{ tipo: 'no_respuesta_vacia' }]), bot([{ respuesta: '' }]));
  const t = informe([ok, mal]);
  assert.match(t, /1\/2 casos pasaron/);
  assert.match(t, /respuesta vacía/);
});

test('Carver suma sus propios casos sobre los comunes', () => {
  assert.equal(casosDeMarca('postgrados').length, CASOS_COMUNES.length);
  assert.ok(casosDeMarca('carver').length > CASOS_COMUNES.length);
});

test('cada caso dice de qué conversación real salió', () => {
  for (const c of casosDeMarca('carver')) {
    assert.ok(c.origen, `el caso "${c.nombre}" no dice de dónde viene`);
    assert.ok(c.mensajes.length > 0);
    assert.ok(c.comprobaciones.length > 0);
  }
});

test('no_afirma_registro_fallido también atrapa el futuro ("quedará registrado")', async () => {
  const r = await ejecutarCaso(
    caso([{ tipo: 'no_afirma_registro_fallido' }]),
    bot([
      {
        respuesta: 'Perfecto, su correo quedará registrado para darle seguimiento.',
        tools: [{ name: 'registrar_interes_crm', input: {}, resultado: { ok: false, error: 'BITRIX_NO_DISPONIBLE' } }],
      },
    ]),
  );
  assert.equal(r.ok, false);
});

test('fee_solo_si_preguntan, no_ofrece_nooc y brochure_verificado detectan los defectos del piloto de Carver', async () => {
  const fee = await ejecutarCaso(caso([{ tipo: 'fee_solo_si_preguntan' }], ['¿Cuánto cuesta?']), bot([{ respuesta: 'Contado USD 900. Titulación USD 125 al finalizar.' }]));
  assert.equal(fee.ok, false);
  const feePedido = await ejecutarCaso(caso([{ tipo: 'fee_solo_si_preguntan' }], ['¿Y la titulación?']), bot([{ respuesta: 'La titulación cuesta USD 125.' }]));
  assert.equal(feePedido.ok, true, 'ante la pregunta explícita sí corresponde');
  const nooc = await ejecutarCaso(caso([{ tipo: 'no_ofrece_nooc' }]), bot([{ respuesta: 'Tenemos cursos cortos gratis, el certificado cuesta USD 20.' }]));
  assert.equal(nooc.ok, false);
  const declina = await ejecutarCaso(caso([{ tipo: 'no_ofrece_nooc' }]), bot([{ respuesta: 'Los cursos gratuitos no forman parte de la oferta de este canal.' }]));
  assert.equal(declina.ok, true, 'declinar no es ofrecer');
  const brochure = await ejecutarCaso(
    caso([{ tipo: 'brochure_verificado' }]),
    bot([{ respuesta: 'Aquí tiene el brochure: https://uachile.bitrix24.es/doc/x', tools: [{ name: 'detalle_programa' }] }]),
  );
  assert.equal(brochure.ok, false, 'un enlace del catálogo sin verificar no vale');
  const verificado = await ejecutarCaso(
    caso([{ tipo: 'brochure_verificado' }]),
    bot([
      {
        respuesta: 'Aquí tiene el brochure: https://uachile.bitrix24.es/doc/x',
        tools: [{ name: 'obtener_brochure', resultado: { ok: true, url: 'https://uachile.bitrix24.es/doc/x' } }],
      },
    ]),
  );
  assert.equal(verificado.ok, true);
});

test('identidad_coherente: siendo el asesor, remitir a "un asesor" es incoherente (caso R09)', async () => {
  const r = await ejecutarCaso(
    caso([{ tipo: 'identidad_coherente', nombre: 'Ignacio Ribera' }]),
    bot([{ respuesta: 'Para descuentos por dos maestrías, eso es algo que tendría que confirmarle un asesor.' }]),
  );
  assert.equal(r.ok, false);
  const bien = await ejecutarCaso(
    caso([{ tipo: 'identidad_coherente', nombre: 'Ignacio Ribera' }]),
    bot([{ respuesta: 'Lo confirmo con el área de admisiones y le respondo por acá.' }]),
  );
  assert.equal(bien.ok, true, bien.fallas.join('; '));
});

test('no_afirma_registro_fallido atrapa "Quedé con sus datos anotados"', async () => {
  const r = await ejecutarCaso(
    caso([{ tipo: 'no_afirma_registro_fallido' }]),
    bot([{ respuesta: 'Quedé con sus datos anotados para darle seguimiento.', tools: [{ name: 'registrar_interes_crm', resultado: { ok: false } }] }]),
  );
  assert.equal(r.ok, false);
});
