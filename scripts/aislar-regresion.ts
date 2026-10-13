// Aislamiento de la suite de regresión. DEBE ser el primer import de scripts/regresion.ts.
//
// En ESM los `import` se evalúan antes que el cuerpo del script: asignar process.env en el cuerpo
// llegaba tarde, cuando config.ts ya había cargado el .env y el KV y la auditoría ya apuntaban a
// Redis y Postgres reales. Con el .env de trabajo eso significaba escribir historiales y filas de
// auditoría de PRUEBA en la base de producción, mezcladas con las métricas del panel.
//
// dotenv no pisa variables ya definidas, aunque estén vacías: dejarlas en '' basta para que el bot
// corra en memoria y sin integraciones. La única credencial que se conserva es la del modelo.
for (const k of [
  'REDIS_URL',
  'DATABASE_URL',
  'BITRIX_WEBHOOK_URL',
  'BITRIX_CLIENT_ID',
  'BITRIX_CLIENT_SECRET',
  'WA_PROVIDER',
  'CHATAPP_EMAIL',
  'CHATAPP_PASSWORD',
  'VAPI_API_KEY',
  'DEEPGRAM_API_KEY',
]) {
  process.env[k] = '';
}
process.env.NODE_ENV = 'test';

export {};
