import { Redis, Cluster } from 'ioredis';
import { readPrivateJson } from '@opencraft/identity-core/node';
import { readFile } from 'node:fs/promises';
import type { RelaySessionStore, SessionKind } from './session-store.js';
import { parsePrincipal, type Principal } from '@opencraft/identity-core';

export interface RelayRedisConfiguration {
  host: string; port: number; mode: 'standalone' | 'cluster'; password: string; username?: string;
  namespace: string; credential: string; internalPort: number; tlsCaFile?: string;
}
export async function readRelayRedisConfiguration(path: string): Promise<RelayRedisConfiguration> {
  const value = await readPrivateJson(path) as Record<string, unknown>;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(k => !['host', 'port', 'mode', 'password', 'username', 'namespace', 'credential', 'internalPort', 'tlsCaFile'].includes(k))
    || typeof value.host !== 'string' || !/^[a-zA-Z0-9.:-]{1,253}$/u.test(value.host)
    || !Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535
    || !['standalone', 'cluster'].includes(String(value.mode)) || typeof value.password !== 'string' || !value.password || value.password.length > 1024
    || (value.username !== undefined && (typeof value.username !== 'string' || !value.username || value.username.length > 128))
    || typeof value.namespace !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/u.test(value.namespace)
    || typeof value.credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value.credential)
    || !Number.isInteger(value.internalPort) || Number(value.internalPort) < 1 || Number(value.internalPort) > 65535
    || (value.tlsCaFile !== undefined && (typeof value.tlsCaFile !== 'string' || !value.tlsCaFile.startsWith('/')))) throw new Error('Invalid private relay Redis configuration');
  return value as unknown as RelayRedisConfiguration;
}

/** A deployment-scoped hash tag keeps every multi-key atomic operation in one Redis Cluster slot. */
export class RelayRedis implements RelaySessionStore {
  readonly client: Redis | Cluster;
  readonly prefix: string;
  #closed = false;
  private constructor(readonly configuration: RelayRedisConfiguration, client: Redis | Cluster) {
    this.client = client; this.prefix = `opencraft:relay:{${configuration.namespace}}:`;
    // Redis error events must be observed, but may contain endpoints or private authentication details.
    client.on('error', () => {});
  }
  static async connect(configuration: RelayRedisConfiguration) {
    const options = { password: configuration.password, ...(configuration.username ? { username: configuration.username } : {}),
      lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, connectTimeout: 4000, commandTimeout: 4000,
      autoResendUnfulfilledCommands: false, ...(configuration.tlsCaFile ? { tls: { ca: await readFile(configuration.tlsCaFile), rejectUnauthorized: true } } : {}) };
    const client = configuration.mode === 'cluster'
      ? new Cluster([{ host: configuration.host, port: configuration.port }], { lazyConnect: true, enableOfflineQueue: false, redisOptions: options,
        clusterRetryStrategy: attempts => attempts > 10 ? null : Math.min(100 * attempts, 1000) })
      : new Redis({ ...options, host: configuration.host, port: configuration.port, retryStrategy: attempts => attempts > 10 ? null : Math.min(100 * attempts, 1000) });
    const redis = new RelayRedis(configuration, client);
    try { await client.connect(); await client.ping(); return redis; }
    catch { redis.close(); throw new Error('Relay Redis is unavailable'); }
  }
  key(suffix: string) { return this.prefix + suffix; }
  async evaluate(script: string, keys: string[], args: (string | number)[] = []) {
    if (this.#closed) throw new Error('Relay Redis is closed');
    try { return await this.client.eval(script, keys.length, ...keys.map(k => this.key(k)), ...args); }
    catch { throw new Error('Relay shared state is unavailable'); }
  }
  async read(key: string) { try { return await this.client.get(this.key(key)); } catch { throw new Error('Relay shared state is unavailable'); } }
  async write(key: string, value: string, milliseconds?: number) {
    try { if (milliseconds) await this.client.set(this.key(key), value, 'PX', milliseconds); else await this.client.set(this.key(key), value); }
    catch { throw new Error('Relay shared state is unavailable'); }
  }
  async get<T>(kind: SessionKind, id: string): Promise<T | null> {
    const value = await this.read(`auth:${kind}:${id}`); return value === null ? null : JSON.parse(value) as T;
  }
  /** Trusted composition may reuse verified identity claims, never session credentials. */
  async knownPrincipals(): Promise<Principal[]> {
    const result = new Map<string, Principal>(), now = Date.now();
    for (let offset = 0; offset < 100_000; offset += 256) {
      const values = await this.evaluate(`local ids=redis.call('ZRANGEBYSCORE',KEYS[1],ARGV[1],'+inf','LIMIT',ARGV[2],256);local out={};for _,id in ipairs(ids) do local value=redis.call('GET',ARGV[3]..id);if value then table.insert(out,value) end end;return {#ids,out}`,
        ['auth-index:sessions'], [now, offset, this.key('auth:sessions:')]) as [number, string[]];
      for (const raw of values[1]) {
        try { const session = JSON.parse(raw), principal = parsePrincipal(session.principal);
          if (session.expiresAt > now && principal.expiresAt > now) result.set(JSON.stringify([principal.provider,principal.subject]),principal);
        } catch { /* Ignore malformed records without exposing their contents. */ }
      }
      if (values[0] < 256) break;
    }
    return [...result.values()];
  }
  async take<T>(kind: SessionKind, id: string): Promise<T | null> {
    const value = await this.evaluate("local v=redis.call('GET',KEYS[1]); if v then redis.call('DEL',KEYS[1]); redis.call('ZREM',KEYS[2],ARGV[1]); end; return v",
      [`auth:${kind}:${id}`, `auth-index:${kind}`], [id]);
    return typeof value === 'string' ? JSON.parse(value) as T : null;
  }
  async put(kind: SessionKind, id: string, value: unknown, expiresAt: number, limit: number) {
    return await this.evaluate(`local now=tonumber(ARGV[1]); local expiry=tonumber(ARGV[2]); if expiry<=now then return 0 end
      redis.call('ZREMRANGEBYSCORE',KEYS[2],'-inf',now)
      if redis.call('ZCARD',KEYS[2])>=tonumber(ARGV[5]) then return 0 end
      redis.call('SET',KEYS[1],ARGV[3],'PX',expiry-now); redis.call('ZADD',KEYS[2],expiry,ARGV[4]); return 1`,
    [`auth:${kind}:${id}`, `auth-index:${kind}`], [Date.now(), expiresAt, JSON.stringify(value), id, limit]) === 1;
  }
  async delete(kind: SessionKind, id: string) { await this.take(kind, id); }
  async claim(key: string, value: string, milliseconds: number) {
    return await this.evaluate("if redis.call('SET',KEYS[1],ARGV[1],'NX','PX',ARGV[2]) then return 1 else return 0 end", [key], [value, milliseconds]) === 1;
  }
  async renew(key: string, value: string, milliseconds: number) {
    return await this.evaluate("if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end; redis.call('PEXPIRE',KEYS[1],ARGV[2]); return 1", [key], [value, milliseconds]) === 1;
  }
  async release(key: string, value: string) {
    await this.evaluate("if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('DEL',KEYS[1]); return 1 end; return 0", [key], [value]);
  }
  close() { if (!this.#closed) { this.#closed = true; this.client.disconnect(); } }
}
