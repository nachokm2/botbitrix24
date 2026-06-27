type Meta = Record<string, unknown>;

function emit(level: string, msg: string, meta?: Meta) {
  // Log estructurado (una línea JSON) — fácil de leer en los logs de Railway.
  console.log(JSON.stringify({ level, msg, ...meta, t: new Date().toISOString() }));
}

export const log = {
  info: (m: string, meta?: Meta) => emit('info', m, meta),
  warn: (m: string, meta?: Meta) => emit('warn', m, meta),
  error: (m: string, meta?: Meta) => emit('error', m, meta),
};
