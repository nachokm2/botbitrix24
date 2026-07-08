// Integración CRM del bot de Open Lines.
//
// La implementación se dividió en submódulos cohesivos (ver ALT-18 de la auditoría):
//   - entities.ts     → tipos + parsers puros de CHAT_ENTITY_DATA_2
//   - chat.ts         → binding chat↔CRM y timeline (memoria entre sesiones)
//   - crmWrite.ts     → escrituras (contacto/lead/deal), notas y persistencia del scoring
//   - directory.ts    → lectura de deal + resolución de usuarios/asesores
//   - voiceActions.ts → acciones del agente de voz (buscar, crear lead, "lead caliente")
//
// Este archivo es un BARREL: re-exporta la API pública para no romper los imports existentes.
export * from './entities';
export * from './chat';
export * from './crmWrite';
export * from './directory';
export * from './voiceActions';
