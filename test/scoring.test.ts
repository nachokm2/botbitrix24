import { test } from 'node:test';
import assert from 'node:assert/strict';

// Funciones puras extraídas de procesarScoring (ver ALT-Media-4 de la auditoría): antes vivían como
// condiciones inline mezcladas con las llamadas al CRM/Vapi, y no se podían testear sin mockear todo
// eso. Ahora son funciones sin I/O, testeables con asserts simples.
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

const { moverEtapaPorScore, autoLlamarPorScore, autoEscalarPorScore } = await import('../src/ai/scoring');

test('moverEtapaPorScore: score alto mueve a la etapa "alto" del embudo del deal', () => {
  const target = moverEtapaPorScore({
    score: 85,
    dealCategory: 1,
    stageMap: { '1': { alto: 'C1:ALTO', medio: 'C1:MEDIO' } },
    stageScoreAlto: '',
    stageScoreMedio: '',
  });
  assert.equal(target, 'C1:ALTO');
});

test('moverEtapaPorScore: score medio mueve a la etapa "medio"', () => {
  const target = moverEtapaPorScore({
    score: 55,
    dealCategory: 1,
    stageMap: { '1': { alto: 'C1:ALTO', medio: 'C1:MEDIO' } },
    stageScoreAlto: '',
    stageScoreMedio: '',
  });
  assert.equal(target, 'C1:MEDIO');
});

test('moverEtapaPorScore: score bajo no mueve nada', () => {
  const target = moverEtapaPorScore({
    score: 20,
    dealCategory: 1,
    stageMap: { '1': { alto: 'C1:ALTO', medio: 'C1:MEDIO' } },
    stageScoreAlto: '',
    stageScoreMedio: '',
  });
  assert.equal(target, '');
});

test('moverEtapaPorScore: no repite la misma etapa a la que ya se movió', () => {
  const target = moverEtapaPorScore({
    score: 85,
    dealCategory: 1,
    lastStage: 'C1:ALTO',
    stageMap: { '1': { alto: 'C1:ALTO', medio: 'C1:MEDIO' } },
    stageScoreAlto: '',
    stageScoreMedio: '',
  });
  assert.equal(target, '');
});

test('moverEtapaPorScore: cae al fallback legacy de un solo embudo si no hay stageMap', () => {
  const target = moverEtapaPorScore({
    score: 85,
    dealCategory: 3,
    stageMap: {},
    stageScoreAlto: 'LEGACY:ALTO',
    stageScoreMedio: 'LEGACY:MEDIO',
  });
  assert.equal(target, 'LEGACY:ALTO');
});

test('moverEtapaPorScore: sin stageMap ni fallback legacy, no mueve nada', () => {
  const target = moverEtapaPorScore({ score: 90, dealCategory: 1, stageMap: {}, stageScoreAlto: '', stageScoreMedio: '' });
  assert.equal(target, '');
});

test('autoLlamarPorScore: score sobre el umbral y sin llamada previa → true', () => {
  assert.equal(autoLlamarPorScore({ score: 60, scoreLlamar: 50 }), true);
});

test('autoLlamarPorScore: umbral desactivado (0) → false', () => {
  assert.equal(autoLlamarPorScore({ score: 90, scoreLlamar: 0 }), false);
});

test('autoLlamarPorScore: ya se llamó antes → false (no duplica)', () => {
  assert.equal(autoLlamarPorScore({ score: 90, scoreLlamar: 50, autoCalled: true }), false);
});

test('autoLlamarPorScore: un humano ya tomó la conversación → false', () => {
  assert.equal(autoLlamarPorScore({ score: 90, scoreLlamar: 50, humanTookOver: true }), false);
});

test('autoEscalarPorScore: score alto y con chatId → true', () => {
  assert.equal(autoEscalarPorScore({ score: 85, scoreEscalar: 80, chatId: 'chat1' }), true);
});

test('autoEscalarPorScore: sin chatId (no es Open Lines) → false', () => {
  assert.equal(autoEscalarPorScore({ score: 85, scoreEscalar: 80 }), false);
});

test('autoEscalarPorScore: ya escalado por score antes → false', () => {
  assert.equal(autoEscalarPorScore({ score: 85, scoreEscalar: 80, chatId: 'chat1', escalatedByScore: true }), false);
});

test('autoEscalarPorScore: un humano ya tomó la conversación → false', () => {
  assert.equal(autoEscalarPorScore({ score: 85, scoreEscalar: 80, chatId: 'chat1', humanTookOver: true }), false);
});
