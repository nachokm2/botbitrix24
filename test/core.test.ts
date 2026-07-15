import { test } from 'node:test';
import assert from 'node:assert/strict';

// Test del núcleo omnicanal (M1): las herramientas de catálogo producen la presentación correcta
// según el PERFIL del canal, desde una sola implementación. Prueba que WhatsApp y Voz —dos canales
// con el mismo motor— obtienen los shapes que cada uno espera.
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

const { consultarProgramas, detallePrograma } = await import('../src/core/catalogTool');
const { WHATSAPP_PROFILE, VOICE_PROFILE, profileFor } = await import('../src/core/channel');

const NOMBRE_CONOCIDO = 'Magíster en Gestión de la Inclusión y Convivencia Educativa';

test('perfiles: WhatsApp y Voz declaran capacidades distintas sobre el mismo motor', () => {
  assert.equal(WHATSAPP_PROFILE.id, 'whatsapp');
  assert.equal(VOICE_PROFILE.id, 'voice');
  // La "longitud de respuesta" del canal difiere (voz más corta).
  assert.ok(WHATSAPP_PROFILE.maxResponseTokens > VOICE_PROFILE.maxResponseTokens);
  // WhatsApp habilita más herramientas (solicitar_llamada / escalar); voz tiene transferir.
  assert.ok(WHATSAPP_PROFILE.toolNames.includes('solicitar_llamada'));
  assert.ok(VOICE_PROFILE.toolNames.includes('transferir_a_asesor'));
  assert.equal(profileFor('voice').id, 'voice');
  assert.throws(() => profileFor('webchat'), /perfil/i);
});

test('consultar_programas (perfil WhatsApp): envuelve ok, limita a 20, objetos completos', () => {
  const r: any = consultarProgramas({ tipo: 'diplomado' }, WHATSAPP_PROFILE.catalog.consultar);
  assert.equal(r.ok, true);
  assert.ok(r.total > 20);
  assert.equal(r.mostrando, 20);
  assert.equal(r.programas.length, 20);
  assert.ok(r.programas[0].url, 'los objetos vienen completos (incluyen url)');
  assert.ok(r.nota, 'nota de "hay más" cuando supera el límite');
});

test('consultar_programas (perfil Voz): sin ok, top 8, objetos reducidos, nota vacía cuando no hay match', () => {
  const many: any = consultarProgramas({ tipo: 'diplomado' }, VOICE_PROFILE.catalog.consultar);
  assert.equal(many.ok, undefined, 'la voz no envuelve con ok');
  assert.equal(many.programas.length, 8);
  assert.equal(many.programas[0].url, undefined, 'los objetos vienen reducidos (sin url)');

  const none: any = consultarProgramas({ texto: 'zzzz-inexistente' }, VOICE_PROFILE.catalog.consultar);
  assert.equal(none.total, 0);
  assert.match(none.nota, /no inventes|afinar|asesor/i);
});

test('detalle_programa: full (chat) devuelve objeto detalle; voice devuelve campos clave', () => {
  const full: any = detallePrograma({ nombre: NOMBRE_CONOCIDO }, WHATSAPP_PROFILE.catalog.detalle);
  assert.equal(full.ok, true);
  assert.ok(full.detalle.arancel);

  const voice: any = detallePrograma({ nombre: NOMBRE_CONOCIDO }, VOICE_PROFILE.catalog.detalle);
  assert.equal(voice.encontrado, true);
  assert.ok(voice.arancel);
  assert.equal(voice.malla, undefined, 'la voz no recibe la malla');
});

test('detalle_programa: desconocido → SIN_DETALLE (chat) / encontrado:false (voz)', () => {
  const full: any = detallePrograma({ nombre: 'no existe abc' }, WHATSAPP_PROFILE.catalog.detalle);
  assert.equal(full.ok, false);
  assert.equal(full.error, 'SIN_DETALLE');

  const voice: any = detallePrograma({ nombre: 'no existe abc' }, VOICE_PROFILE.catalog.detalle);
  assert.equal(voice.encontrado, false);
});
