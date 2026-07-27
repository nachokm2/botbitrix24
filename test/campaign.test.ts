import { test } from 'node:test';
import assert from 'node:assert/strict';

// Fase 0: registro de programas (escalabilidad por config) + seguridad no-op de la capa de datos sin PG.
process.env.REDIS_URL = '';
process.env.DATABASE_URL = ''; // sin Postgres → los helpers de campaña deben no-operar sin lanzar
process.env.NODE_ENV = 'test';
// Config del programa MMD por entorno (se lee al importar el registro).
process.env.CAMPAIGN_MMD_ACTIVO = 'true';
process.env.CAMPAIGN_MMD_CATEGORY_ID = '3';
process.env.BITRIX_UF_PROGRAMA = 'UF_CRM_TEST_PROG';

const { getProgram, activePrograms, programByCategory, filtroCola } = await import('../src/campaign/programRegistry');

test('programRegistry: MMD existe con la agenda 3x3 por defecto', () => {
  const mmd = getProgram('MMD');
  assert.ok(mmd, 'MMD está registrado');
  assert.equal(mmd!.nombre, 'Magíster en Marketing Digital');
  assert.deepEqual(mmd!.agenda.waves, ['09:15', '14:15', '18:45']);
  assert.equal(mmd!.agenda.maxPorDia, 3);
  assert.equal(mmd!.agenda.maxDias, 3);
  assert.equal(mmd!.agenda.maxTotal, 9);
  assert.equal(mmd!.agenda.tz, 'America/Santiago');
});

test('programRegistry: getProgram desconocido → undefined', () => {
  assert.equal(getProgram('XXX'), undefined);
  assert.equal(getProgram(undefined), undefined);
});

test('programRegistry: activePrograms respeta la bandera activo', () => {
  const activos = activePrograms();
  assert.ok(activos.some((p) => p.code === 'MMD'), 'MMD activo cuando CAMPAIGN_MMD_ACTIVO=true');
});

test('programRegistry: programByCategory resuelve por embudo', () => {
  const p = programByCategory(3);
  assert.equal(p?.code, 'MMD');
  assert.equal(programByCategory(999), undefined);
});

test('programRegistry: filtroCola incluye embudo + UF de programa', () => {
  const mmd = getProgram('MMD')!;
  const f = filtroCola(mmd);
  assert.equal(f.CATEGORY_ID, 3);
  assert.equal(f.CLOSED, 'N');
  assert.equal(f.UF_CRM_TEST_PROG, 'Magíster en Marketing Digital');
});

test('db campaña: helpers no-operan sin Postgres (no lanzan)', async () => {
  const db = await import('../src/store/db');
  assert.equal(await db.dbEnrollCampaignTarget({ dealId: 1, programCode: 'MMD' }), false);
  assert.equal(await db.dbGetCampaignTarget(1), null);
  assert.deepEqual(await db.dbDueCampaignTargets('MMD', new Date(0).toISOString(), { maxTotal: 9, maxDias: 3, limit: 10 }), []);
  assert.deepEqual(await db.dbCampaignCounts('MMD'), {});
  // Las escrituras deben resolver sin efecto ni excepción.
  await db.dbUpdateCampaignTarget(1, { status: 'PENDING' });
  assert.equal(await db.dbInsertCallAttempt({ dealId: 1, programCode: 'MMD', attemptNo: 1 }), null);
  await db.dbUpdateCallAttemptByVapiId('vapi-x', { answered: true });
});
