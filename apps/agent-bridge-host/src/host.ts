import { isAbsolute } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createSandboxPool, type SandboxBackend, type SandboxPoolPolicy, type SandboxPool } from '@opencraft/sandbox';
import { BRIDGE_GRAMMAR_RANGE, BRIDGE_PROTOCOL_VERSION, isBridgeCommand, assertMethodAllowed, negotiateHandshake, type BridgeInitializeResult } from '@opencraft/agent-bridge-protocol';
import { Storage } from './storage.js';
import { Peer, successful } from './peer.js';
import { object, identifier, routeKey, type Command, type Generation, type Receipt } from './types.js';
/** Error kinds that are definitive refusals before any native write. */
const REFUSED_BRIDGE_ERRORS = new Set(['auth', 'explicit-reject', 'frame-too-large', 'invalid', 'quota', 'stale-target', 'unsupported']);
/** Deterministic object encoding makes the digest independent of JSON key order. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + stable(v)).join(',') + '}';
  return JSON.stringify(value);
}
export interface HostOptions { path: string; policy: SandboxPoolPolicy; backend: SandboxBackend; maxSpoolBytes?: number; requestTimeoutMs?: number }
export class BridgeHost {
  private storage: Storage;
  private pool!: SandboxPool;
  private diagnosticPeers = new Map<string, Peer>();
  private peers = new Map<string, Promise<Peer>>();
  private capabilities = new Map<string, BridgeInitializeResult['effectiveCapabilities']>();
  private admissions = new Set<Promise<Receipt>>();
  private tasks = new Set<Promise<void>>();
  private closing = false;
  private retainedAfterCrash = new Set<string>();
  private generations = new Map<string, Generation>();
  readonly incarnation = randomUUID();
  private constructor(private options: HostOptions) {
    this.storage = new Storage(options.path, 'host', () => {
      this.closing = true;
      if (this.pool) void this.pool.close().catch(() => {}); // retained cleanup promise is rechecked by close()
    });
  }
  static async open(options: HostOptions): Promise<BridgeHost> {
    const host = new BridgeHost(options);
    try {
      await host.storage.ready;
      host.pool = await createSandboxPool(options.policy, options.backend);
      const snapshot = await host.storage.call('snapshot');
      for (const row of snapshot.generations) if (!row.retired) host.generations.set(row.id, row.config);
      for (const row of snapshot.routes) host.retainedAfterCrash.add(row.generation);
      return host;
    } catch (error) { await host.storage.close().catch(() => {}); throw error; }
  }
  async add(config: Generation): Promise<void> {
    if (this.closing) throw Error('Host closing');
    config = structuredClone(config);
    identifier(config.id); identifier(config.digest);
    if (!/^[a-f0-9]{64}$/.test(config.digest) || !isAbsolute(config.artifact)) throw Error('Absolute pinned bundle and SHA-256 required');
    const negotiation = negotiateHandshake({ protocolVersion: BRIDGE_PROTOCOL_VERSION, grammarRange: BRIDGE_GRAMMAR_RANGE }, config.provider);
    if (!negotiation.ok) throw Error(negotiation.error.message);
    await this.storage.call('add', config); this.generations.set(config.id, config);
  }
  async activate(id: string, expected: string): Promise<void> {
    if (this.closing) throw Error('Host closing');
    await this.peer(id); // no new default until sandbox and negotiation succeeded
    await this.storage.call('activate', { id, expected });
  }
  private peer(id: string): Promise<Peer> {
    let pending = this.peers.get(id);
    if (pending) return pending;
    const config = this.generations.get(id);
    if (this.retainedAfterCrash.has(id)) return Promise.reject(Error('Retained generation requires explicit native recovery; automatic replacement refused'));
    if (!config) return Promise.reject(Error('Pinned generation unavailable'));
    pending = (async () => {
      if (createHash('sha256').update(await readFile(config.artifact)).digest('hex') !== config.digest || !config.launch.command.includes(config.artifact)) throw Error('Pinned bridge artifact digest mismatch');
      const peer = new Peer(config, async (callbackId, method, params) => {
        await this.storage.call('callback', { generation: id, id: callbackId, method, params: object(params) });
      }, this.options.requestTimeoutMs);
      this.diagnosticPeers.set(id, peer);
      try {
        await peer.start(this.pool);
        const reply = await peer.request(`host-init:${randomUUID()}`, 'initialize', { protocolVersion: BRIDGE_PROTOCOL_VERSION, grammarRange: BRIDGE_GRAMMAR_RANGE });
        if (!successful(reply)) throw Error('Bridge initialize rejected');
        const result = object(reply.result);
        const expected = negotiateHandshake({ protocolVersion: BRIDGE_PROTOCOL_VERSION, grammarRange: BRIDGE_GRAMMAR_RANGE }, config.provider);
        if (!expected.ok || result.protocolVersion !== expected.result.protocolVersion || result.grammarVersion !== expected.result.grammarVersion || result.approvalExecutor !== expected.result.approvalExecutor) throw Error('Invalid bridge negotiation');
        // Probe is narrowing-only; validate it against the registered upper bound.
        const caps = object(result.effectiveCapabilities);
        const upper = expected.result.effectiveCapabilities;
        for (const key of ['model','reasoning','history','usage','approval','cliExecutable','forkCheckpoint','skills','installation'] as const)
          if (typeof caps[key] !== 'boolean' || caps[key] && !upper[key]) throw Error('Bridge widened capabilities');
        const steer = object(caps.steer);
        for (const key of ['deliveryMethods','evidenceKinds'] as const)
          if (!Array.isArray(steer[key]) || !(steer[key] as unknown[]).every(v => (upper.steer[key] as readonly unknown[]).includes(v))) throw Error('Bridge widened steer capability');
        if (!Array.isArray(caps.inputContentTypes) || !caps.inputContentTypes.every(v => upper.inputContentTypes.includes(v))) throw Error('Invalid input types');
        const limits = object(steer.contentLimits);
        if (!Number.isSafeInteger(limits.maxBytes) || Number(limits.maxBytes) < 1 || Number(limits.maxBytes) > upper.steer.contentLimits.maxBytes
          || !Array.isArray(limits.allowedContentTypes) || !limits.allowedContentTypes.every(v => upper.steer.contentLimits.allowedContentTypes.includes(v))
          || !Number.isSafeInteger(steer.maxPendingWithoutNativeId) || Number(steer.maxPendingWithoutNativeId) < 1 || Number(steer.maxPendingWithoutNativeId) > upper.steer.maxPendingWithoutNativeId
          || ![upper.steer.withdrawal, 'none'].includes(steer.withdrawal as any)
          || ![upper.steer.fallbackPolicy, 'reject-unknown'].includes(steer.fallbackPolicy as any)) throw Error('Invalid steer limits or policy');
        this.capabilities.set(id, result.effectiveCapabilities as BridgeInitializeResult['effectiveCapabilities']);
        return peer;
      } catch (error) { await peer.close(); throw error; }
    })();
    this.peers.set(id, pending); return pending; // failed generations never auto-restart native writers
  }
  accept(raw: unknown): Promise<Receipt> {
    const admission = this.admit(raw);
    this.admissions.add(admission);
    void admission.finally(() => this.admissions.delete(admission)).catch(() => {});
    return admission;
  }
  private async admit(raw: unknown): Promise<Receipt> {
    if (this.closing) throw Error('Host closing');
    const command = structuredClone(object(raw)) as unknown as Command;
    identifier(command.commandId); identifier(command.serverId); identifier(command.threadId); object(command.params);
    if (!isBridgeCommand(command.method) || (command.method as string) === 'initialize') throw Error('Unsupported command');
    const serialized = stable(command);
    if (Buffer.byteLength(serialized) > 512 * 1024) throw Error('Command too large');
    const digest = createHash('sha256').update(serialized).digest('hex');
    const route = routeKey(command.serverId, command.threadId);
    const result = await this.storage.call<{ receipt: Receipt; fresh: boolean }>('admit', { command, digest, route, maxSpoolBytes: this.options.maxSpoolBytes ?? 64 * 1024 ** 2 });
    if (result.fresh) {
      const task = this.dispatch(command, result.receipt);
      this.tasks.add(task); void task.finally(() => this.tasks.delete(task)).catch(() => {});
    }
    return result.receipt; // admission is durable, never waits for native response
  }
  private async dispatch(command: Command, receipt: Receipt): Promise<void> {
    // Fence is committed BEFORE preparing or writing a native request.
    await this.storage.call('dispatch', { id: command.commandId });
    try {
      const peer = await this.peer(receipt.generation);
      const admission = assertMethodAllowed(this.capabilities.get(receipt.generation)!, command.method);
      if (!admission.ok) {
        await this.storage.call('settle', { id: command.commandId, state: 'rejected' }); return;
      }
      const response = await peer.request(`host-command:${command.commandId}`, command.method, { ...command.params, threadId: receipt.route, executionEpoch: receipt.epoch });
      // These kinds are definitive provider refusals before any native write
      // (validation, capability gating, auth/quota, stale target). A timeout,
      // transport loss or internal/unknown-outcome stays `unknown`.
      const state = successful(response) ? 'accepted' : 'error' in response && REFUSED_BRIDGE_ERRORS.has(response.error.kind) ? 'rejected' : 'unknown';
      await this.storage.call('settle', { id: command.commandId, response, state, interactionId: command.params.interactionId });
    } catch {
      await this.storage.call('settle', { id: command.commandId, state: 'unknown' });
    }
  }
  threadState(serverId: string, threadId: string): Promise<any> { return this.storage.call('threadState', { route: routeKey(serverId, threadId) }); }
  diagnostics(): unknown { return [...this.diagnosticPeers].map(([generation, peer]) => ({ generation, ...peer.diagnostic() })); }
  query(id: string): Promise<Receipt | null> { return this.storage.call('query', { id }); }
  async snapshot(): Promise<any> { return { ...await this.storage.call('snapshot'), databaseOutcome: await this.storage.ready }; }
  events(cursor: number, limit = 256): Promise<any> { return this.storage.call('events', { cursor, limit }); }
  ack(cursor: number): Promise<void> { return this.storage.call('ack', { cursor }); }
  releaseThread(serverId: string, threadId: string): Promise<void> { return this.storage.call('releaseRoute', { route: routeKey(serverId, threadId) }); }
  async retire(id: string): Promise<void> {
    await this.storage.call('retire', { id }); // refuse before touching a busy peer
    const peer = this.peers.get(id); if (peer) await (await peer).close();
    this.generations.delete(id);
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.admissions]);
    const cleanup = await Promise.allSettled([
      this.pool.close(),
      ...[...this.peers.values()].map(async pending => { const peer = await pending.catch(() => undefined); if (peer) await peer.close(); }),
    ]);
    await Promise.allSettled([...this.tasks]);
    const storage = await Promise.allSettled([this.storage.close()]);
    const failures = [...cleanup, ...storage].filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => (result as PromiseRejectedResult).reason), 'Bridge owner cleanup unconfirmed');
  }
}
