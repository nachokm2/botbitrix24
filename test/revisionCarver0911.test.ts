import { test } from 'node:test';
import assert from 'node:assert/strict';

// Lo que salió de leer 424 conversaciones de Carver, del 03 al 09-11-2026: claves copiadas en el
// chat, bajas que no se respetaron, un mensaje de riesgo seguido de recordatorios de venta, y
// recordatorios que inventaban gestiones, cifras y programas.
process.env.MARCA = 'carver';
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

const { quitarCredenciales, CREDENCIAL_OCULTA } = await import('../src/core/credenciales');
const { redactPII } = await import('../src/obs/redact');
const { pideNoMolestar } = await import('../src/crm/exclusion');
const { esRechazo, problemasDelRecordatorio } = await import('../src/ai/seguimiento');
const { mensajeDeRiesgo } = await import('../src/core/riesgo');
const { programaFueraDeOferta } = await import('../src/core/oferta');
const { matchProgramaCarver } = await import('../src/core/condicionesCarver');
const { SYSTEM_PROMPT } = await import('../src/ai/prompt');
const { MANEJO_OBJECIONES } = await import('../src/core/promptObjeciones');

test('una clave no sale en lo que escribe el bot', () => {
  const r = quitarCredenciales('¡Ahí están sus credenciales! - Usuario: [email] - Contraseña: AB4417203 - Plataforma: Canvas');
  assert.equal(r.cambiado, true);
  assert.doesNotMatch(r.texto, /AB4417203/);
  assert.match(r.texto, new RegExp(`Contraseña: \\${CREDENCIAL_OCULTA.slice(0, 1)}`));
  assert.match(r.texto, /Plataforma: Canvas/); // lo demás queda igual
  assert.doesNotMatch(quitarCredenciales('Su clave temporal es 8842XY.').texto, /8842XY/);
  assert.doesNotMatch(quitarCredenciales('password= Abc#2024').texto, /Abc#2024/);
});

test('hablar de la contraseña sin darla no cambia nada', () => {
  for (const t of [
    'Puede recuperar la contraseña de su correo desde el enlace del mensaje de bienvenida.',
    'Si la contraseña correcta no funciona, escriba a soporte.',
    'No comparta su clave por este chat.',
  ]) {
    const r = quitarCredenciales(t);
    assert.equal(r.cambiado, false, t);
    assert.equal(r.texto, t);
  }
});

test('una clave pública de las fuentes del bot sí sale', () => {
  // La base trae la clave para verificar la licencia en el registro de Florida.
  const fuente = '{"verificacion":"Registro de la CIE, clave: Qz7Lm2Xk9p"}';
  const r = quitarCredenciales('Puede verificarlo en el registro (clave: Qz7Lm2Xk9p).', fuente);
  assert.equal(r.cambiado, false);
  assert.match(r.texto, /Qz7Lm2Xk9p/);
});

test('la auditoría tampoco guarda claves', () => {
  const d = redactPII({ reply: 'Usuario: ana@correo.com Contraseña: XyZ12345' }) as any;
  assert.doesNotMatch(d.reply, /XyZ12345|ana@correo\.com/);
});

test('«voy a bloquearlos» es una baja y corta los recordatorios', () => {
  for (const t of ['Voy a bloquearlos', 'los voy a bloquear', 'Esto es spam', 'Eliminen mi número por favor']) {
    assert.equal(pideNoMolestar(t), true, t);
    assert.equal(esRechazo(t), true, t);
  }
  for (const t of ['¿Cómo desbloqueo mi cuenta?', '¿Me bloquean la matrícula si pago tarde?', 'Me interesa la maestría']) {
    assert.equal(pideNoMolestar(t), false, t);
  }
});

test('un mensaje de riesgo se reconoce, una pregunta académica no', () => {
  assert.equal(mensajeDeRiesgo('Pero pinorra Unos suicidio'), true);
  assert.equal(mensajeDeRiesgo('ya no quiero vivir'), true);
  assert.equal(mensajeDeRiesgo('Me quiero morir, nada me sale'), true);
  assert.equal(mensajeDeRiesgo('¿La Maestría en Psicología ve prevención del suicidio?'), false);
  assert.equal(mensajeDeRiesgo('Trabajo en un protocolo de riesgo suicida en mi colegio'), false);
  assert.equal(mensajeDeRiesgo('Hola, quiero información del MBA'), false);
  // Un audio real: hablaba de con quién vivir, no de vivir (chat 1476745).
  assert.equal(mensajeDeRiesgo('vivo sola, no quiero vivir con nadie por el momento'), false);
});

test('el recordatorio no inventa gestiones, cifras ni beneficios', () => {
  const inventado = problemasDelRecordatorio(
    '¿Qué tal? Como le prometí, le confirmo que hablé con admisión sobre el reconocimiento en Ecuador.',
  );
  assert.ok(inventado.some((p) => /consultó o confirmó/.test(p)), inventado.join(' | '));
  assert.ok(problemasDelRecordatorio('¿Le acomodan las 18 cuotas de USD 100?').some((p) => /cifras/.test(p)));
  assert.ok(problemasDelRecordatorio('Tengo un beneficio adicional para usted, ¿le cuento?').some((p) => /beneficio/.test(p)));
  assert.deepEqual(problemasDelRecordatorio('¿Sigues con interés en la Maestría en Psicología? Con un sí me basta.'), []);
  // Lo cierto no se marca: el contado sí trae un descuento adicional, y la beca es del 50 %.
  assert.deepEqual(problemasDelRecordatorio('¿Te cuento el valor con la beca del 50%? Al contado tiene un descuento adicional.'), []);
  // Carver tutea desde el 13-11-2026: la gestión inventada se reconoce también dicha de tú.
  assert.ok(problemasDelRecordatorio('Como te prometí, te confirmo que hablé con admisión.').some((p) => /consultó o confirmó/.test(p)));
});

test('«la maestría en este momento» no es el nombre de un programa', () => {
  for (const t of [
    '¿Ha habido cambios que le permitan considerar la maestría en este momento?',
    '¿Cuál es su licenciatura de base para confirmar que aplica?',
    '¿Le gustaría que le cuente más sobre alguna maestría en específico?',
    '¿Recibió el brochure de la Maestría en Ergonomía en su WhatsApp?',
  ]) {
    assert.ok(!problemasDelRecordatorio(t).some((p) => /no está en la oferta/.test(p)), t);
  }
});

test('el recordatorio no nombra programas que no están en la oferta', () => {
  const existe = (n: string) => matchProgramaCarver(n).length > 0;
  assert.equal(programaFueraDeOferta('¿Le interesa la Maestría en Inteligencia Artificial?', existe), null);
  assert.match(String(programaFueraDeOferta('Le cuento del Diplomado en Salud Mental y Psiquiatría', existe)), /Diplomado en Salud Mental/);
  assert.match(String(programaFueraDeOferta('¿Sigue pensando en la Licenciatura en Educación Física?', existe)), /Educación Física/);
  assert.equal(programaFueraDeOferta('Además tiene acceso a cursos de Coursera.', existe), null);
  assert.ok(problemasDelRecordatorio('¿Le sigo contando del Diplomado en Pruebas en el Proceso Penal?').some((p) => /no está en la oferta/.test(p)));
});

test('el prompt de Carver trae las reglas nuevas', () => {
  assert.match(SYSTEM_PROMPT, /«los programas», «las maestrías» o «la oferta» en general/);
  assert.match(SYSTEM_PROMPT, /responde a una plantilla que preguntaba por OTRA cosa/);
  assert.match(SYSTEM_PROMPT, /sede en Florida/);
  assert.match(SYSTEM_PROMPT, /NO AFIRMES SIN FUENTE/);
  assert.match(SYSTEM_PROMPT, /CLAVES: NUNCA escribas una contraseña/);
  assert.match(MANEJO_OBJECIONES, /contadoPorAnio/);
  assert.match(MANEJO_OBJECIONES, /la autoridad educativa de su país/);
});
