import Redis from 'ioredis';
import { config } from '../config';
import { log } from '../log';

// Abstracción clave-valor: Redis si hay REDIS_URL, si no, memoria (con TTL).
// Todas las operaciones degradan con gracia: ante error no rompen el flujo del bot.

interface KvBackend {
  get(key: string): Promise<string | null>;
  set(key: string, val: string, ttlSec?: number): Promise<void>;
  del(key: string): Promise<void>;
}

class MemoryKv implements KvBackend {
  private m = new Map<string, { v: string; exp?: number }>();
  async get(key: string) {
    const e = this.m.get(key);
    if (!e) return null;
    if (e.exp && e.exp < Date.now()) {
      this.m.delete(key);
      return null;
    }
    return e.v;
  }
  async set(key: string, val: string, ttlSec?: number) {
    this.m.set(key, { v: val, exp: ttlSec ? Date.now() + ttlSec * 1000 : undefined });
  }
  async del(key: string) {
    this.m.delete(key);
  }
}

class RedisKv implements KvBackend {
  constructor(private r: Redis) {}
  async get(key: string) {
    return this.r.get(key);
  }
  async set(key: string, val: string, ttlSec?: number) {
    if (ttlSec) await this.r.set(key, val, 'EX', ttlSec);
    else await this.r.set(key, val);
  }
  async del(key: string) {
    await this.r.del(key);
  }
}

let backend: KvBackend;
export let kvKind = 'memory';

if (config.redisUrl) {
  try {
    const client = new Redis(config.redisUrl, { maxRetriesPerRequest: 2, lazyConnect: false });
    client.on('error', (e) => log.warn('redis error', { err: String(e?.message ?? e) }));
    backend = new RedisKv(client);
    kvKind = 'redis';
    log.info('KV: usando Redis');
  } catch (e) {
    log.error('KV: Redis falló, uso memoria', { err: String(e) });
    backend = new MemoryKv();
  }
} else {
  backend = new MemoryKv();
  log.info('KV: usando memoria (sin REDIS_URL)');
}

export async function kvGet(key: string): Promise<string | null> {
  try {
    return await backend.get(key);
  } catch (e) {
    log.warn('kvGet falló', { key, err: String(e) });
    return null;
  }
}

export async function kvSet(key: string, val: string, ttlSec?: number): Promise<void> {
  try {
    await backend.set(key, val, ttlSec);
  } catch (e) {
    log.warn('kvSet falló', { key, err: String(e) });
  }
}

export async function kvDel(key: string): Promise<void> {
  try {
    await backend.del(key);
  } catch (e) {
    log.warn('kvDel falló', { key, err: String(e) });
  }
}

export async function getJson<T>(key: string): Promise<T | null> {
  const raw = await kvGet(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function setJson(key: string, val: unknown, ttlSec?: number): Promise<void> {
  await kvSet(key, JSON.stringify(val), ttlSec);
}

/** Marca una clave una sola vez (idempotencia). Devuelve true si es la PRIMERA vez. */
export async function once(key: string, ttlSec = 3600): Promise<boolean> {
  const seen = await kvGet(key);
  if (seen) return false;
  await kvSet(key, '1', ttlSec);
  return true;
}
