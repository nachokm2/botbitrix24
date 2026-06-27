type Meta = Record<string, unknown>;

function emit(level: string, msg: string, meta?: Meta) {
  const extra = meta && Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  // Una sola línea de texto plano: Railway la muestra completa (no colapsa metadata).
  console.log(`${level.toUpperCase()} ${msg}${extra}`);
}

export const log = {
  info: (m: string, meta?: Meta) => emit('info', m, meta),
  warn: (m: string, meta?: Meta) => emit('warn', m, meta),
  error: (m: string, meta?: Meta) => emit('error', m, meta),
};
