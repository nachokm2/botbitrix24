import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vecesQuePreguntoPorTrabajo, bloqueNoRepetirPreguntaPorTrabajo } from '../src/core/preguntasRepetidas';

// Caso del 15-11-2026 (piloto de India): una persona que buscaba trabajo recibió seis veces seguidas
// «what field are you from…?», una hora después de publicada la regla de «a lo más dos veces».
const B = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] });
const U = (content: string) => ({ role: 'user', content });

const HISTORIAL = [
  U('Hello! Can I get more info on this?'),
  B("You're already in the right place! 16 weeks, 100% online. What's your educational background or field of work?"),
  U('Heyy'),
  B('Hey! To help you best — are you a recent graduate or do you have some work experience, and what field are you from?'),
  U('actully I am Looking Job'),
  B("This programme doesn't offer job placement. What field are you from? That'll help me show you how relevant this could be."),
];

test('cuenta solo las preguntas por el trabajo, en inglés, hinglish e hindi', () => {
  assert.equal(vecesQuePreguntoPorTrabajo(HISTORIAL), 3);
  // Una afirmación no es una pregunta.
  assert.equal(vecesQuePreguntoPorTrabajo([B("As a data analyst, you'd get a lot out of it. Would you like to know how to enrol?")]), 0);
  assert.equal(vecesQuePreguntoPorTrabajo([B('Aap kya kaam karte hain?'), B('आप क्या काम करते हैं?')]), 2);
  assert.equal(vecesQuePreguntoPorTrabajo([U('What do you do?')]), 0, 'lo que pregunta la persona no cuenta');
});

test('desde la segunda pregunta, aviso estricto en el turno; antes, nada', () => {
  assert.equal(bloqueNoRepetirPreguntaPorTrabajo(HISTORIAL.slice(0, 2)), '');
  const b = bloqueNoRepetirPreguntaPorTrabajo(HISTORIAL);
  assert.match(b, /TURN NOTE \(strict\): you have already asked about their work, field or background 3 times/);
  assert.match(b, /Do not ask about it again in this reply/);
});
