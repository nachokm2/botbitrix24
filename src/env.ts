import dotenv from 'dotenv';

// Carga el .env, salvo dentro del runner de pruebas.
//
// config.ts lo cargaba siempre, así que `npm test` en la carpeta del repo leía el .env real —el
// webhook de administrador de Bitrix, la base de datos y el Redis de producción, las claves de
// Anthropic, Twilio y Vapi— y una prueba a la que le faltara un mock podía escribir en producción.
// El CI no lo notaba porque allí no hay .env. `node --test` marca sus subprocesos con
// NODE_TEST_CONTEXT: con esa marca no se carga nada y las pruebas corren igual que en el CI.
//
// Va en su propio módulo, importado ANTES que todo en config.ts, porque marca.ts lee MARCA al
// importarse: si el .env se cargara más tarde, la marca local quedaría mal resuelta.
if (!process.env.NODE_TEST_CONTEXT) dotenv.config();
