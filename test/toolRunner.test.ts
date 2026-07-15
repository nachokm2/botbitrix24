import { test } from 'node:test';
import assert from 'node:assert/strict';

// Test de integración del dispatch de herramientas del chat (executeTool). Cubre las ramas que NO
// tocan servicios externos: catálogo (puro), guardas de validación y tool desconocida.
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

const { executeTool } = await import('../src/ai/toolRunner');
const { WHATSAPP_PROFILE } = await import('../src/core/channel');

const ctx = {
  auth: { domain: '', access_token: '' },
  conversationId: 't-1',
  botId: 1,
  crmEntities: {},
  crmEntity: null,
  profile: WHATSAPP_PROFILE,
} as any;

test('consultar_programas: devuelve catálogo real y limita a 20 con nota', async () => {
  const r = await executeTool('consultar_programas', { tipo: 'diplomado' }, ctx);
  assert.equal(r.ok, true);
  assert.ok(r.total > 20, 'hay más de 20 diplomados en el catálogo');
  assert.equal(r.mostrando, 20, 'muestra máximo 20');
  assert.equal(r.programas.length, 20);
  assert.ok(r.nota, 'incluye nota de que hay más resultados');
});

test('consultar_programas: filtra por texto', async () => {
  const r = await executeTool('consultar_programas', { texto: 'inteligencia artificial' }, ctx);
  assert.equal(r.ok, true);
  assert.ok(r.total >= 1);
  assert.ok(r.programas.every((p: any) => typeof p.url === 'string' && p.url.startsWith('http')));
});

test('detalle_programa: programa conocido devuelve detalle con arancel', async () => {
  const r = await executeTool(
    'detalle_programa',
    { nombre: 'Magíster en Gestión de la Inclusión y Convivencia Educativa' },
    ctx,
  );
  assert.equal(r.ok, true);
  assert.ok(r.detalle);
  assert.ok(r.detalle.arancel, 'trae el arancel cargado');
});

test('detalle_programa: programa inexistente devuelve SIN_DETALLE', async () => {
  const r = await executeTool('detalle_programa', { nombre: 'Programa que no existe xyz' }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'SIN_DETALLE');
});

test('solicitar_llamada: teléfono no chileno válido se rechaza antes de llamar', async () => {
  const r = await executeTool('solicitar_llamada', { telefono: '+12025550123' }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'TELEFONO_INVALIDO');
});

test('solicitar_llamada: cadena no numérica se rechaza', async () => {
  const r = await executeTool('solicitar_llamada', { telefono: 'no-es-un-numero' }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'TELEFONO_INVALIDO');
});

test('tool desconocida devuelve UNKNOWN_TOOL', async () => {
  const r = await executeTool('herramienta_inexistente', {}, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'UNKNOWN_TOOL');
});
