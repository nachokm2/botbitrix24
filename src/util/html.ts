const ENTIDADES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapa texto para insertarlo en HTML armado en el servidor, como contenido o como atributo entre
 *  comillas. */
export function escaparHtml(valor: unknown): string {
  return String(valor ?? '').replace(/[&<>"']/g, (c) => ENTIDADES[c]);
}
