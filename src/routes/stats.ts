import { escaparHtml as h } from '../util/html';

type Snapshot = { startedAt: string } & Record<string, unknown>;
type FilaAuditoria = { ts?: unknown; type?: unknown; dialog_id?: unknown; crm_entity?: unknown };

/**
 * HTML de /stats. Todo lo interpolado va escapado: entre los contadores hay claves que arma el
 * scoring con la salida del clasificador (p.ej. `intencion:<lo que respondió el modelo>`), y al modelo
 * lo puede dirigir el cliente con su mensaje. Sin escapar, eso era un XSS almacenado en una página que
 * se abre con el token del panel en la URL.
 */
export function paginaStats(m: Snapshot, audits: FilaAuditoria[], kv: string, conDb: boolean): string {
  const rows = audits
    .map(
      (a) =>
        `<tr><td>${h(a.ts)}</td><td>${h(a.type)}</td><td>${h(a.dialog_id ?? '')}</td><td>${h(a.crm_entity ?? '')}</td></tr>`,
    )
    .join('');
  return (
    `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui,sans-serif;padding:1.5rem;line-height:1.4">` +
    `<h2>PoC Agente — Observabilidad</h2>` +
    `<p>KV: <b>${h(kv)}</b> · DB: <b>${conDb ? 'postgres' : 'off'}</b> · activo desde ${h(m.startedAt)}</p>` +
    `<h3>Métricas</h3><pre>${h(JSON.stringify(m, null, 2))}</pre>` +
    `<h3>Auditoría reciente${conDb ? '' : ' (sin Postgres: solo en logs)'}</h3>` +
    `<table border="1" cellpadding="6" style="border-collapse:collapse"><tr><th>ts</th><th>type</th><th>dialog</th><th>crm</th></tr>${rows}</table>` +
    `</body>`
  );
}
