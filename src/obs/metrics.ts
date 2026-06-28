// Métricas en memoria (contadores + latencia LLM). Snapshot para /metrics.
const counters: Record<string, number> = {};
const latencies: number[] = [];
const startedAt = new Date().toISOString();

export function inc(name: string, n = 1): void {
  counters[name] = (counters[name] ?? 0) + n;
}

export function recordLlmLatency(ms: number): void {
  latencies.push(ms);
  if (latencies.length > 500) latencies.shift();
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
}

export function snapshot() {
  const avg = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
  return {
    startedAt,
    counters,
    llm: { samples: latencies.length, avgMs: avg, p95Ms: pct(latencies, 95) },
  };
}
