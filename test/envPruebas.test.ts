import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// src/env.ts no debe cargar el .env dentro del runner de pruebas: con el .env real del repo, una
// prueba sin mock podía escribir en producción. Fuera del runner sí debe cargarlo (desarrollo local).
// Se prueba en un proceso aparte y en una carpeta con su propio .env, porque dotenv lee el .env del
// directorio de trabajo y este mismo proceso ya corre dentro del runner.
const envTs = new URL('../src/env.ts', import.meta.url).href;
const tsx = import.meta.resolve('tsx');

function valorCargado(dir: string, dentroDelRunner: boolean): string {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.SENTINELA_ENV;
  if (dentroDelRunner) env.NODE_TEST_CONTEXT = 'child-v8';
  else delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(
    process.execPath,
    ['--import', tsx, '--input-type=module', '-e', `await import(${JSON.stringify(envTs)}); console.log('SENTINELA=' + (process.env.SENTINELA_ENV ?? 'ausente'));`],
    { cwd: dir, env, encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr);
  const linea = r.stdout.split(/\r?\n/).find((l) => l.startsWith('SENTINELA='));
  return linea?.slice('SENTINELA='.length) ?? '(sin salida)';
}

test('env.ts: dentro del runner de pruebas NO carga el .env', () => {
  const dir = mkdtempSync(join(tmpdir(), 'env-pruebas-'));
  try {
    writeFileSync(join(dir, '.env'), 'SENTINELA_ENV=cargado\n');
    assert.equal(valorCargado(dir, true), 'ausente');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('env.ts: fuera del runner sí carga el .env (desarrollo local)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'env-pruebas-'));
  try {
    writeFileSync(join(dir, '.env'), 'SENTINELA_ENV=cargado\n');
    assert.equal(valorCargado(dir, false), 'cargado');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
