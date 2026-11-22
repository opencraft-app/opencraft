import { terminalResourceOwnerId } from './host-resource-identity.js';
export { terminalResourceOwnerId } from './host-resource-identity.js';
import { DurableHostProcessService } from '@opencraft/local-agent-host/durable-process-service';
import { TerminalCapacityError, type PreparedProcessIdentity } from '@opencraft/local-agent-host/process-service';
import { validateEnvironmentName } from '@opencraft/execution-environment/account-environment';
import { LOGICAL_CLIENT_FIELD } from '@opencraft/app-host-protocol';
import { OPENCRAFT_METHOD_ACCESS_EXTENSION } from '@opencraft/appserver-protocol';
import type { DuplexTransport, TransportSubmissionContext } from '@opencraft/appserver-client';
import type { EnvironmentExecutionScope, ExecutionEnvironmentRuntime } from '@opencraft/execution-environment';

export const HOST_TERMINAL_METHODS = ['process/spawn', 'process/attach', 'process/list', 'process/writeStdin', 'process/resizePty', 'process/kill'] as const;
const methods = new Set<string>(HOST_TERMINAL_METHODS);
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
export type HostTerminalScope = EnvironmentExecutionScope & { readonly actorId?: string };

/** One private Hands client per Host. Engine switching never changes the PTY owner. */
export function createHandsTerminalService(options: { directory: string; endpoint: string; tokenFile: string; environment?: ExecutionEnvironmentRuntime }) {
  return new DurableHostProcessService(options.directory, undefined, {
    endpoint: options.endpoint, tokenFile: options.tokenFile,
    prepare(method, raw, scope): PreparedProcessIdentity {
      if (!scope?.account) throw new Error('Terminal principal missing');
      const actor = (scope as HostTerminalScope).actorId ?? scope.account;
      const identity: PreparedProcessIdentity = { scope,
        owner: terminalResourceOwnerId(actor, scope.hostId), quotaOwner: terminalResourceOwnerId(actor, scope.hostId) };
      if (method !== 'process/spawn') return identity;
      const env = { ...(options.environment?.snapshot(scope).overlay() ?? {}) };
      const requested = object(raw).env;
      if (requested != null && (typeof requested !== 'object' || Array.isArray(requested))) throw new Error('Invalid terminal environment');
      for (const [key, value] of Object.entries(object(object(raw).env))) {
        validateEnvironmentName(key);
        if (Object.hasOwn(env, key)) throw new Error('Managed terminal environment cannot be overridden');
        if (value !== null && typeof value !== 'string') throw new Error('Invalid terminal environment');
        if (typeof value === 'string') env[key] = value;
      }
      identity.env = env;
      return identity;
    },
  });
}

/** Structural service port: local durable owner or one already-admitted sandbox.
 * Selection is trusted composition, never a service ID accepted from an RPC. */
export type HostTerminalService = Pick<DurableHostProcessService, 'probe' | 'subscribe'> & {
  dispatch(method:string,params:unknown,scope?:EnvironmentExecutionScope,assertCurrent?:()=>void,onAccepted?:()=>void,
    /** Original trusted ingress for this operation, never the last subscriber. */
    context?:TransportSubmissionContext):Promise<unknown>;
};
/** Context is the private authenticated ingress object, never process params. */
export type HostTerminalServiceSelector = (scope: EnvironmentExecutionScope, context: TransportSubmissionContext) => Promise<HostTerminalService>;

// Created once per ingress so product selectors can retain stable service wrappers.
export function composeHostTerminalSelector(
  hostId: string,
  service: HostTerminalService,
  select: ((scope: EnvironmentExecutionScope, context: TransportSubmissionContext, local: HostTerminalServiceSelector) => Promise<HostTerminalService>) | undefined,
): HostTerminalServiceSelector | undefined {
  if (!select) return undefined;
  const local: HostTerminalServiceSelector = async scope => {
    if (scope.hostId !== hostId) throw Error('Local terminal Host mismatch');
    return service;
  };
  return (scope, context) => select(scope, context, local);
}

/** Shared routing for leased AppHost and the existing raw AppServer ingress. */
export class HostTerminalSession {
  private readonly listeners = new Set<(frame: string) => void>();
  private readonly watched = new Map<string, Map<string, { context: TransportSubmissionContext; params: Record<string, any>; scope: EnvironmentExecutionScope; clientId: unknown; service: HostTerminalService }>>();
  private readonly initialized = new Set<string>();
  private readonly initializing = new Set<string>();
  private readonly removes = new Map<HostTerminalService, () => void>();
  private closed = false;
  private available = false;
  constructor(private readonly service: HostTerminalService,
    private readonly authorize: (context: TransportSubmissionContext, params: Record<string, any>) => EnvironmentExecutionScope,
    private readonly selectService?: HostTerminalServiceSelector) {
    this.watchService(service);
  }
  private watchService(service: HostTerminalService) {
    if (this.removes.has(service)) return;
    if (this.removes.size >= 128) throw new Error('Too many terminal bindings');
    this.removes.set(service, service.subscribe((method, params) => {
      const handle = object(params).processHandle;
      const watchers = this.watched.get(handle);
      for (const [key, watcher] of watchers ?? []) {
        if (watcher.service !== service) continue;
        try {
          const current = this.authorize(watcher.context, watcher.params);
          if (JSON.stringify(current) !== JSON.stringify(watcher.scope)) { watchers?.delete(key); continue; }
          this.emit({ method, params, [LOGICAL_CLIENT_FIELD]: watcher.clientId });
        } catch { watchers?.delete(key); }
        if (method === 'process/exited') watchers?.delete(key);
      }
      if (watchers?.size === 0) this.watched.delete(handle);
    }));
  }
  private emit(message: unknown) { for (const listener of this.listeners) listener(JSON.stringify(message)); }
  async connect() {
    // Positive capability only after the configured owner answers. No local fallback.
    this.available = await this.service.probe().then(() => true, () => false);
  }
  close() { this.closed = true; for (const remove of this.removes.values()) remove(); this.removes.clear(); this.watched.clear(); this.initialized.clear(); this.initializing.clear(); this.listeners.clear(); }
  subscribeMessage(listener: (frame: string) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  project(frame: string): string | null {
    const value = object(JSON.parse(frame));
    const key = JSON.stringify([value[LOGICAL_CLIENT_FIELD] ?? '', value.id]);
    if (this.initializing.delete(key) && !value.error) {
      this.initialized.add(String(value[LOGICAL_CLIENT_FIELD] ?? ''));
      const result = object(value.result), capabilities = object(result.capabilities), extensions = object(capabilities.extensions);
      const access = object(extensions[OPENCRAFT_METHOD_ACCESS_EXTENSION]);
      value.result = { ...result, capabilities: { ...capabilities, extensions: { ...extensions,
        ...(Array.isArray(access.methods) ? { [OPENCRAFT_METHOD_ACCESS_EXTENSION]: { version: 1,
          methods: [...new Set([...access.methods.filter((method: string) => !method.startsWith('process/')), ...(this.available || this.selectService ? HOST_TERMINAL_METHODS : [])])] } } : {}),
        'opencraft/terminal': { version: 1, available: this.available, recovery: this.available,
          ...(this.selectService ? { selection: 'per-request' } : {}) },
      } } };
    }
    // All process messages belong to the selected Hands owner.
    if (typeof value.method === 'string' && value.method.startsWith('process/')) return null;
    return JSON.stringify(value);
  }
  async receive(frame: string, context: TransportSubmissionContext, signal?: AbortSignal): Promise<boolean> {
    const value = object(JSON.parse(frame)), params = object(value.params), clientId = value[LOGICAL_CLIENT_FIELD];
    if (value.method === 'initialize') this.initializing.add(JSON.stringify([clientId ?? '', value.id]));
    if (typeof value.method !== 'string' || !value.method.startsWith('process/')) {
      return false;
    }
    try {
      signal?.throwIfAborted();
      if (this.closed || (!this.available && !this.selectService) || !this.initialized.has(String(clientId ?? '')) || !methods.has(value.method)) throw new Error('Terminal unavailable');
      const scope = this.authorize(context, params);
      const current = () => {
        signal?.throwIfAborted();
        if (this.closed || JSON.stringify(scope) !== JSON.stringify(this.authorize(context, params))) throw new Error('Terminal authority changed');
      };
      // Resolution failure must reject, never fall back to the local owner. The
      // selector resolves an already-authorized durable binding; it must not
      // provision a sandbox from untrusted request metadata.
      const service = this.selectService ? await this.selectService(scope, context) : this.service;
      current();
      // The default local probe is not evidence about a selected workspace.
      // Recheck authorization after the asynchronous probe before dispatch.
      if (this.selectService) { await service.probe(); current(); }
      this.watchService(service);
      const result = await service.dispatch(value.method, params, scope, current, () => {
        if (typeof params.processHandle !== 'string' || !['process/spawn', 'process/attach'].includes(value.method)) return;
        const watchers = this.watched.get(params.processHandle) ?? new Map();
        watchers.set(JSON.stringify([clientId ?? '', scope]), { context, params, scope, clientId, service }); this.watched.set(params.processHandle, watchers);
      }, context);
      current(); this.emit({ id: value.id, result, [LOGICAL_CLIENT_FIELD]: clientId });
    } catch (error) {
      if (this.closed) return true;
      this.emit({ id: value.id, [LOGICAL_CLIENT_FIELD]: clientId,
        error: { code: error instanceof TerminalCapacityError ? -32029 : -32602,
          message: error instanceof TerminalCapacityError ? error.message : 'Terminal unavailable for this account or workspace' } });
    }
    return true;
  }
}

export class HostTerminalTransport implements DuplexTransport {
  private readonly terminal: HostTerminalSession;
  private closed = false;
  constructor(private readonly inner: DuplexTransport, service: HostTerminalService,
    authorize: (context: TransportSubmissionContext, params: Record<string, any>) => EnvironmentExecutionScope,
    selectService?: HostTerminalServiceSelector) {
    this.terminal = new HostTerminalSession(service, authorize, selectService);
  }
  get status() { return this.inner.status; }
  async connect(signal?: AbortSignal) { await this.terminal.connect(); await this.inner.connect(signal); }
  async close() { this.closed = true; this.terminal.close(); await this.inner.close(); }
  subscribeStatus(listener: Parameters<DuplexTransport['subscribeStatus']>[0]) { return this.inner.subscribeStatus(listener); }
  captureMessageScope() { return this.inner.captureMessageScope?.() ?? (() => !this.closed && this.inner.status.state === 'open'); }
  subscribeRecoveryHint(listener: () => void) { return this.inner.subscribeRecoveryHint?.(listener) ?? (() => {}); }
  subscribeMessage(listener: (frame: string) => void) {
    const removeTerminal = this.terminal.subscribeMessage(listener);
    const removeNative = this.inner.subscribeMessage(frame => { const projected = this.terminal.project(frame); if (projected !== null) listener(projected); });
    return () => { removeTerminal(); removeNative(); };
  }
  send(frame: string, signal?: AbortSignal) { return this.sendWithContext(frame, { sender: null }, signal); }
  async sendWithContext(frame: string, context: TransportSubmissionContext, signal?: AbortSignal) {
    if (await this.terminal.receive(frame, context, signal)) return;
    if (this.inner.sendWithContext) return this.inner.sendWithContext(frame, context, signal);
    return this.inner.send(frame, signal);
  }
}
