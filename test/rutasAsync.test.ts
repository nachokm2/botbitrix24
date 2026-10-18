import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { NextFunction, Request, Response } from 'express';

// Un handler async que lanza no debe tumbar el proceso. Antes bastaba un POST /install sin
// credenciales con `application_token[toString]=1`: el parser urlencoded (qs con allowPrototypes)
// lo entrega como un objeto cuyo toString no es función, String() lanza dentro del handler async,
// Express 4 no captura el rechazo y Node 24 termina el proceso. Se prueba con un servidor real y el
// mismo parser que usa index.ts.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
// Un portal configurado: así /install rechaza el dominio inventado sin intentar ninguna conexión.
process.env.BITRIX_WEBHOOK_URL = 'https://portal.ejemplo.invalid/rest/1/x/';

const { manejarAsync, manejadorDeErrores, describirError } = await import('../src/routes/errores');
const { installHandler, oauthCodeOrNext } = await import('../src/routes/install');

async function conServidor(app: express.Express, fn: (base: string) => Promise<void>) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

function appComoProduccion() {
  const app = express();
  app.use(express.urlencoded({ extended: true, limit: '2mb' })); // el mismo parser que index.ts
  // El patrón exacto del defecto: un handler async que pasa un campo del cuerpo por String().
  app.post('/eco', manejarAsync(async (req, res) => {
    res.send(String((req.body as Record<string, unknown>).application_token));
  }));
  app.all('/install', manejarAsync(installHandler));
  app.get('/vivo', (_req, res) => res.send('ok'));
  app.use(manejadorDeErrores);
  return app;
}

const cuerpoArmado = () =>
  new URLSearchParams({ AUTH_ID: 'a', DOMAIN: 'b.invalid', 'application_token[toString]': '1' });

test('un handler async que lanza responde 500 y el proceso sigue atendiendo', async () => {
  await conServidor(appComoProduccion(), async (base) => {
    const r = await fetch(`${base}/eco`, { method: 'POST', body: cuerpoArmado() });
    assert.equal(r.status, 500);
    assert.deepEqual(await r.json(), { ok: false, error: 'internal_error' });
    assert.equal(await (await fetch(`${base}/vivo`)).text(), 'ok');
  });
});

test('POST /install con el cuerpo armado ya no tumba el servidor', async () => {
  await conServidor(appComoProduccion(), async (base) => {
    const r = await fetch(`${base}/install`, { method: 'POST', body: cuerpoArmado() });
    assert.ok(r.status >= 400, `debe rechazarse (status ${r.status})`);
    assert.equal(await (await fetch(`${base}/vivo`)).text(), 'ok');
  });
});

test('oauthCodeOrNext devuelve la promesa de la instalación (antes la descartaba con void)', async () => {
  // Sin BITRIX_CLIENT_ID el canje falla antes de cualquier conexión y responde 400.
  let status = 0;
  const res = { status: (s: number) => ((status = s), res), send: () => res } as unknown as Response;
  const req = { query: { code: 'x' }, body: {}, path: '/app' } as unknown as Request;
  const r = oauthCodeOrNext(req, res, () => assert.fail('con ?code= no debe pasar al panel'));
  assert.ok(r && typeof (r as Promise<unknown>).then === 'function', 'devuelve una promesa');
  await r;
  assert.equal(status, 400);
});

test('manejadorDeErrores delega en Express si la respuesta ya empezó (p.ej. tras el ACK a Bitrix)', () => {
  const err = new Error('tarde');
  let recibido: unknown;
  const res = { headersSent: true, status: () => assert.fail('no debe escribir otra respuesta') } as unknown as Response;
  manejadorDeErrores(err, { method: 'POST', path: '/x' } as Request, res, ((e: unknown) => (recibido = e)) as NextFunction);
  assert.equal(recibido, err);
});

test('describirError no lanza con un objeto cuyo toString no es función', () => {
  const raro = { toString: '1' } as unknown;
  assert.doesNotThrow(() => describirError(raro));
  assert.equal(describirError(raro), '[object Object]');
  assert.match(describirError(new TypeError('x')), /TypeError: x/);
});
