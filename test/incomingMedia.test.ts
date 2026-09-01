import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// extractIncomingMedia: bajar los adjuntos (imagen/audio) de un mensaje de WhatsApp/Open Lines.
// Caso real que motivó imbot.v2.File.download: disk.file.get daba ACCESS_DENIED, im.disk.file.get
// daba ERROR_METHOD_NOT_FOUND, y urlDownload+auth devolvía el HTML de login — las 3 vías fallaban
// SIEMPRE para adjuntos de Open Lines, y el bot terminaba sin poder "ver" ninguna imagen.
process.env.NODE_ENV = 'test';

type Call = { method: string; params: any };
const calls: Call[] = [];
let imbotDownloadUrl: string | null = null;
let diskDownloadUrl: string | null = null;

mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === 'imbot.v2.File.download') return imbotDownloadUrl ? { downloadUrl: imbotDownloadUrl } : {};
      if (method === 'im.disk.file.get') throw new Error('Bitrix im.disk.file.get: ERROR_METHOD_NOT_FOUND Method not found!');
      return {};
    },
    callBitrixEnvelope: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === 'disk.file.get') return { result: diskDownloadUrl ? { DOWNLOAD_URL: diskDownloadUrl } : {} };
      return { result: {} };
    },
    callCrm: async () => ({}),
    callCrmEnvelope: async () => ({ result: {} }),
    callWebhook: async () => ({}),
  },
});

const IMG_BYTES = Buffer.from('contenido-imagen-fake');
const realFetch = globalThis.fetch;
(globalThis as any).fetch = async (url: string) => {
  const u = String(url);
  if (u === 'http://ok.test/imbot') {
    return { ok: true, headers: new Headers({ 'content-type': 'image/jpeg' }), arrayBuffer: async () => IMG_BYTES.buffer.slice(IMG_BYTES.byteOffset, IMG_BYTES.byteOffset + IMG_BYTES.byteLength) } as any;
  }
  if (u === 'http://ok.test/disk') {
    return { ok: true, headers: new Headers({ 'content-type': 'image/jpeg' }), arrayBuffer: async () => IMG_BYTES.buffer.slice(IMG_BYTES.byteOffset, IMG_BYTES.byteOffset + IMG_BYTES.byteLength) } as any;
  }
  if (u.startsWith('http://login.test/')) {
    return { ok: true, headers: new Headers({ 'content-type': 'text/html' }), arrayBuffer: async () => new TextEncoder().encode('<html>login</html>').buffer } as any;
  }
  return realFetch(u as any);
};

const { extractIncomingMedia } = await import('../src/media/incoming');
const auth = { domain: 'test.bitrix24.com', access_token: 'tok' } as any;

function paramsConImagen(urlDownload = 'http://login.test/legacy') {
  return {
    CHAT_ID: '1410143',
    FILES: { '20124047': { id: 20124047, type: 'image', name: 'foto.jpg', extension: 'jpg', urlDownload } },
  };
}

test('extractIncomingMedia: usa imbot.v2.File.download cuando hay botId (la vía que sí funciona en producción)', async () => {
  calls.length = 0;
  imbotDownloadUrl = 'http://ok.test/imbot';
  diskDownloadUrl = null;

  const media = await extractIncomingMedia(paramsConImagen(), auth, 701561);

  assert.equal(media.length, 1);
  assert.equal(media[0].kind, 'image');
  assert.equal(media[0].mediaType, 'image/jpeg');
  assert.ok(calls.find((c) => c.method === 'imbot.v2.File.download' && c.params.botId === 701561 && c.params.fileId === 20124047));
  // No necesitó caer a los respaldos.
  assert.ok(!calls.find((c) => c.method === 'disk.file.get'));
});

test('extractIncomingMedia: si imbot.v2.File.download no trae downloadUrl, cae a disk.file.get', async () => {
  calls.length = 0;
  imbotDownloadUrl = null; // simula {} sin downloadUrl (o el método fallando)
  diskDownloadUrl = 'http://ok.test/disk';

  const media = await extractIncomingMedia(paramsConImagen(), auth, 701561);

  assert.equal(media.length, 1, 'igual logra bajar la imagen por el respaldo');
  assert.ok(calls.find((c) => c.method === 'disk.file.get'));
});

test('extractIncomingMedia: sin botId, no intenta imbot.v2.File.download (compatibilidad hacia atrás)', async () => {
  calls.length = 0;
  imbotDownloadUrl = 'http://ok.test/imbot';
  diskDownloadUrl = null;

  await extractIncomingMedia(paramsConImagen(), auth);

  assert.ok(!calls.find((c) => c.method === 'imbot.v2.File.download'), 'sin botId no hay forma de llamar al método');
});

test('extractIncomingMedia: si TODAS las vías fallan, devuelve [] en vez de lanzar', async () => {
  calls.length = 0;
  imbotDownloadUrl = null;
  diskDownloadUrl = null;

  const media = await extractIncomingMedia(paramsConImagen('http://login.test/legacy'), auth, 701561);

  assert.deepEqual(media, []);
});
