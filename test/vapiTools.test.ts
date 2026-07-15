import { test } from 'node:test';
import assert from 'node:assert/strict';

// Test de integración del dispatch de herramientas de VOZ (runVapiTool). Cubre las ramas que no
// tocan la red: catálogo (puro), detalle, transferir_a_asesor sin deal, y tool desconocida.
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';
process.env.VOICE_TRANSFER_FALLBACK = '+56221234567';

const { runVapiTool } = await import('../src/voice/vapiTools');

const auth = { domain: '', access_token: '' } as any;
const ctx = { callId: 'call-1', phone: '+56911112222', crm: {} } as any;

test('consultar_programas (voz): top 8 con nota cuando hay más', async () => {
  const r = await runVapiTool('consultar_programas', { tipo: 'diplomado' }, ctx, auth);
  assert.ok(r.total > 8);
  assert.equal(r.programas.length, 8, 'la voz recibe como máximo 8 resultados');
  assert.ok(r.nota, 'sugiere afinar porque hay más');
  assert.ok(r.programas.every((p: any) => p.nombre && p.tipo));
});

test('consultar_programas (voz): sin coincidencias sugiere derivar y no inventa', async () => {
  const r = await runVapiTool('consultar_programas', { texto: 'zzzzz-tema-inexistente' }, ctx, auth);
  assert.equal(r.total, 0);
  assert.match(r.nota, /asesor|afinar|no inventes/i);
});

test('detalle_programa (voz): conocido devuelve datos; desconocido no encontrado', async () => {
  const ok = await runVapiTool(
    'detalle_programa',
    { nombre: 'Magíster en Gestión de la Inclusión y Convivencia Educativa' },
    ctx,
    auth,
  );
  assert.equal(ok.encontrado, true);
  assert.ok(ok.arancel);

  const miss = await runVapiTool('detalle_programa', { nombre: 'no existe abc' }, ctx, auth);
  assert.equal(miss.encontrado, false);
});

test('transferir_a_asesor: sin deal devuelve destino de fallback y sin asesor', async () => {
  const r = await runVapiTool('transferir_a_asesor', { motivo: 'lo pide' }, ctx, auth);
  assert.equal(r.transferir, true);
  assert.equal(r.asesor, null, 'no inventa asesor cuando no hay deal');
  assert.equal(r.destino, '+56221234567', 'usa VOICE_TRANSFER_FALLBACK');
});

test('tool de voz desconocida devuelve error', async () => {
  const r = await runVapiTool('inexistente', {}, ctx, auth);
  assert.equal(r.error, 'UNKNOWN_TOOL');
});
