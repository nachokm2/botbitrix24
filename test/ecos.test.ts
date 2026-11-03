import { test } from 'node:test';
import assert from 'node:assert/strict';

// Lo nuestro que vuelve al chat como si fuera del cliente (core/ecos.ts). Los textos son mensajes
// reales del fin de semana del 31-10-2026.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

const { esEnvioNuestroPorChatApp, esRespuestaAutomaticaDeNegocio, respuestaAPlantilla, adjuntosSonDeLaPlantilla } = await import('../src/core/ecos');

const SEP = '------------------------------------------------------';
// Chat 1562493: la plantilla de Global Talks trae un video, y Ariel solo contestó «Si».
const GLOBAL_TALKS =
  `${SEP}\n"Hola, Ariel Abraham Gonzalez Arce 👋\n\nNuestros estudiantes participan en Global Talks, webinars certificados.\n\n` +
  `▶️ Mira un poco de esta experiencia.\n\nResponde SÍ y te contamos más." | [Si]\n${SEP}\nSi`;
const MAS_INFO =
  `${SEP}\nHola, *Galicia Castillo Gil*, soy *Basthian Sepúlveda*, espero que te encuentres muy bien!\n\n` +
  `¿Te gustaría conocer más sobre tu programa? | [Más información]\n${SEP}\nMás información`;

test('el adjunto de una plantilla citada es nuestro, no del cliente (chat 1562493)', () => {
  assert.equal(respuestaAPlantilla(GLOBAL_TALKS), 'Si');
  assert.equal(adjuntosSonDeLaPlantilla(GLOBAL_TALKS), true);
  assert.equal(respuestaAPlantilla(MAS_INFO), 'Más información');
  assert.equal(adjuntosSonDeLaPlantilla(MAS_INFO), true);
});

test('un archivo que manda la persona se sigue procesando', () => {
  // Nota de voz real: llega como enlace al CDN de ChatApp, sin plantilla citada.
  const audio = '[URL=https://cdn-eu-central-2.chatapp.online/api2.chatapp.online/chatFiles/50126/caWhatsApp/a.oga]a.oga[/URL]';
  assert.equal(respuestaAPlantilla(audio), null);
  assert.equal(adjuntosSonDeLaPlantilla(audio), false);
  // Si contesta la plantilla con su propio archivo, el archivo es de ella.
  assert.equal(adjuntosSonDeLaPlantilla(`${MAS_INFO.split(SEP + '\nMás')[0]}${SEP}\n${audio}`), false);
  // Texto común: ni plantilla ni eco.
  assert.equal(adjuntosSonDeLaPlantilla('Hola, quiero información de la maestría'), false);
  assert.equal(respuestaAPlantilla(`Le copio lo que me llegó:\n${SEP}\nhola\n${SEP}\nok`), null, 'la cita tiene que abrir el mensaje');
});

test('el brochure que mandó el bot por ChatApp no es un mensaje del cliente', () => {
  const eco =
    '[B]Sent from external application[/B]\n[URL=https://cdn-eu-central-2.chatapp.online/api2.chatapp.online/chatFiles/x.pdf]Open[/URL]\nBrochure — Maestría en Inteligencia Artificial';
  assert.equal(esEnvioNuestroPorChatApp(eco), true);
  assert.equal(esEnvioNuestroPorChatApp('Sent from external application, ¿qué es esto?'), false);
  assert.equal(esEnvioNuestroPorChatApp(undefined), false);
});

// Bienvenidas automáticas de WhatsApp Business que llegaron como si fueran del cliente (25-10 al
// 03-11-2026); los nombres de los negocios están cambiados.
test('reconoce la respuesta automática de un WhatsApp Business', () => {
  for (const t of [
    'Gracias por comunicarte con Mi Negocio Uno. Nuestro Horario atención es: PREVIA COORDINACIÓN DE CITA!',
    'Hola 🤗, gracias por comunicarte con Creaciones Dos 🍰, en cuanto pueda me pondré en contacto contigo',
    'Gracias por comunicarte con servicio Tres en que puedo ayudar',
    '"¡Hola! Gracias por escribir. En este momento no estoy disponible, pero he recibido tu mensaje y te responderé en cuanto me sea posible."',
    'Gracias por tu mensaje. En este momento no podemos responder, pero lo haremos lo antes posible.',
    'Hola, gracias por escribir. He recibido tu mensaje y responderé tan pronto como me sea posible.',
  ]) {
    assert.equal(esRespuestaAutomaticaDeNegocio(t), true, t);
  }
});

test('no confunde a una persona con una respuesta automática', () => {
  for (const t of [
    'Gracias por la información, ¿cuánto cuesta la maestría?',
    'Hola, gracias por comunicarte conmigo. Me interesa el MBA',
    'En este momento estoy en el trabajo, le escribo más tarde',
    'Si',
    `${SEP}\nHola, gracias por comunicarte con Carver University 👋 ¿te interesa la maestría?\n${SEP}\nSi`,
  ]) {
    assert.equal(esRespuestaAutomaticaDeNegocio(t), false, t);
  }
  assert.equal(esRespuestaAutomaticaDeNegocio(undefined), false);
});
