import { isAbsolute } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createSandboxPool, type SandboxBackend, type SandboxPoolPolicy, type SandboxPool } from '@opencraft/sandbox';
import { BRIDGE_GRAMMAR_RANGE, BRIDGE_PROTOCOL_VERSION, isBridgeCommand, assertMethodAllowed, negotiateHandshake, type BridgeInitializeResult, type BridgeWireMessage } from '@opencraft/agent-bridge-protocol';
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
function hostRefusal(command: Command, message: string): Error & { code: number; kind: string; commandId: string } {
  return Object.assign(Error(message), { code: -32602, kind: 'invalid', commandId: command.commandId });
}

/**
 * A typed provider error that deterministically refuses the command means the
 * native mutation was not performed. Only an ambiguous transport/timeout or
 * an explicit `unknown-outcome` keeps custody unknown; treating stale/invalid
 * refusals as unknown would block Thread release forever.
 */
export function dispatchSettlement(response: BridgeWireMessage): Receipt['state'] {
  if (successful(response)) return 'accepted';
  if ('error' in response) return REFUSED_BRIDGE_ERRORS.has(response.error.kind) ? 'rejected' : 'unknown';
  return 'unknown';
}

export interface ExecutionCliLease {
  environment: Readonly<Record<string,string>>;
  revoke(): Promise<void>;
}
/** Configured by trusted Server/Host composition, never by command arguments. */
export interface ExecutionCliPort {
  forward?(token:string,body:unknown):Promise<{status:number;body:unknown}>;
  issue(source: {serverId:string;threadId:string;credential:string}): Promise<ExecutionCliLease>;
}
export interface HostOptions { executionCli?: ExecutionCliPort; path: string; policy: SandboxPoolPolicy; backend: SandboxBackend; maxSpoolBytes?: number; requestTimeoutMs?: number }
export class BridgeHost {
  private readonly cliGenerations = new Map<string,string>();
  private readonly cliPending = new Set<string>();
  private readonly cliClosedTurns = new Map<string,string>();
  private readonly cliLeases = new Map<string,ExecutionCliLease>();
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
        const p=object(params);
        const closed=method==='thread/delta' && Array.isArray(p.deltas) ? p.deltas.find((delta:any)=>delta.op==='turn.close' || delta.op==='session.ended') as {nativeTurnId?:string;op:string}|undefined : undefined;
        if(closed && this.cliClosedTurns.get(String(p.threadId))!==(closed.nativeTurnId??closed.op)) {
          this.cliClosedTurns.set(String(p.threadId),closed.nativeTurnId??closed.op);
          const lease=this.cliLeases.get(String(p.threadId));
          if(lease){await lease.revoke();this.cliLeases.delete(String(p.threadId));}
        }
      }, this.options.requestTimeoutMs,()=>{
        for(const [route,lease] of this.cliLeases)if(this.cliGenerations.get(route)===id) {
          this.cliLeases.delete(route);this.cliGenerations.delete(route);
          const task=lease.revoke();this.tasks.add(task);void task.finally(()=>this.tasks.delete(task)).catch(()=>{});
        }
      });
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
        this.capabilities.set(id, {...result.effectiveCapabilities as BridgeInitializeResult['effectiveCapabilities'],cliExecutable:!!this.options.executionCli && caps.cliExecutable===true});
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
    if (command.method === 'session/resume') {
      const state = await this.storage.call<{ nativeSession: { native_id: string; restorable: number } | null }>('threadState', { route });
      const native = state.nativeSession;
      const requested = command.params?.providerThreadId ?? command.params?.nativeSessionId;
      if (!native) throw hostRefusal(command, 'Thread has no recorded native session');
      if (native.restorable !== 1) throw hostRefusal(command, 'Recorded native session is not restorable');
      if (requested !== undefined && native.native_id !== requested) throw hostRefusal(command, 'Resume id does not match the recorded restorable native session');
    }
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
      let cliEnvironment: Readonly<Record<string,string>> | undefined;
      if(command.method==='turn/start' && this.options.executionCli) {
        try {
          if(!this.capabilities.get(receipt.generation)?.cliExecutable)throw Error('cliUnavailable');
          const credential=command.params.executionSource;
          if(typeof credential!=='string'||credential.length>4096)throw Error('cliUnavailable');
          if(this.cliLeases.has(receipt.route)||this.cliPending.has(receipt.route))throw Error('cliUnavailable');
          this.cliPending.add(receipt.route);
          const lease=await this.options.executionCli.issue({serverId:command.serverId,threadId:command.threadId,credential});
          this.cliLeases.set(receipt.route,lease);this.cliGenerations.set(receipt.route,receipt.generation);cliEnvironment=lease.environment;
        } catch {
          await this.storage.call('settle',{id:command.commandId,state:'rejected',response:{jsonrpc:'2.0',id:`host-command:${command.commandId}`,
            error:{code:-32001,kind:'unsupported',message:'cliUnavailable'}}});return;
        } finally {this.cliPending.delete(receipt.route);}
      }
      const {executionSource:_executionSource,...providerParams}=command.params;
      const response = await peer.request(`host-command:${command.commandId}`, command.method, { ...providerParams, ...(cliEnvironment?{cliEnvironment}:{}), threadId: receipt.route, executionEpoch: receipt.epoch });
      const state = dispatchSettlement(response);
      await this.storage.call('settle', { id: command.commandId, response, state, interactionId: command.params.interactionId });
      if (state === 'rejected' && command.method === 'session/create') {
        const failure = 'error' in response ? (response.error.data as { failure?: unknown } | undefined)?.failure : undefined;
        // Only failures that leave no resumable native session release the
        // fresh route binding. pending/exists/locked/orphaned keep it so the
        // client can resume or explicitly recover the same native session.
        if (failure === 'invalid' || failure === 'unavailable' || failure === 'orphaned') {
          await this.storage.call('abandon', { route: receipt.route, id: command.commandId }).catch(() => {});
        }
      }
      if(state==='rejected' || command.method==='turn/stop' && state==='accepted' || command.method==='session/close' && state==='accepted') {
        const lease=this.cliLeases.get(receipt.route);
        if(lease){await lease.revoke();this.cliLeases.delete(receipt.route);}
      }
    } catch {
      await this.storage.call('settle', { id: command.commandId, state: 'unknown' });
    }
  }
  async cli(token:string,body:unknown) {
    if(this.closing||!this.options.executionCli?.forward)throw Error('cliUnavailable');
    return this.options.executionCli.forward(token,body);
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
      ...[...this.cliLeases.values()].map(lease=>lease.revoke()),
      ...[...this.peers.values()].map(async pending => { const peer = await pending.catch(() => undefined); if (peer) await peer.close(); }),
    ]);
    await Promise.allSettled([...this.tasks]);
    const storage = await Promise.allSettled([this.storage.close()]);
    const failures = [...cleanup, ...storage].filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => (result as PromiseRejectedResult).reason), 'Bridge owner cleanup unconfirmed');
  }
}
