import type { DuplexTransport, TransportSubmissionContext } from '../packages/appserver-client/src/transport.js';
import { LOGICAL_CLIENT_FIELD } from '@opencraft/app-host-protocol';
import { EXECUTION_ENVIRONMENT_FIELD, type ExecutionEnvironmentRuntime, type EnvironmentExecutionScope } from './execution-environment.js';
import { TerminalCapacityError } from '../apps/local-agent-host/src/process-service.js';
import { DurableHostProcessService } from '../apps/local-agent-host/src/durable-process-service.js';
const terminals = new WeakMap<ExecutionEnvironmentRuntime, DurableHostProcessService>();
const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const key = (v: Record<string, any>) => JSON.stringify([v[LOGICAL_CLIENT_FIELD] ?? '', v.id]);

/** The ingress strips browser-supplied envelopes and mints its own from the
 * authenticated submission. Only encrypted identity/scope crosses owner IPC. */
export class ExecutionEnvironmentTransport implements DuplexTransport {
  private readonly listeners = new Set<(frame: string) => void>();
  private readonly watched = new Map<string, { clientId: unknown; context: TransportSubmissionContext }>();
  private readonly processes: DurableHostProcessService;
  private readonly unsubscribeProcesses: () => void;
  private readonly pending = new Map<string, { method: string; projectId: string | null; threadId?: string }>();
  constructor(private readonly inner: DuplexTransport, private readonly runtime: ExecutionEnvironmentRuntime, private readonly hostId: string) {
    let service = terminals.get(runtime);
    if (!service) { service = new DurableHostProcessService(runtime.directory, runtime); terminals.set(runtime, service); runtime.onClose(() => service!.close()); }
    this.processes = service;
    this.unsubscribeProcesses = service.subscribe((method, params) => {
      const watcher = this.watched.get(object(params).processHandle);
      if (method === 'process/exited') this.watched.delete(object(params).processHandle);
      if (!watcher || watcher.context.executionPrincipal && (!Number.isFinite(watcher.context.validUntil) || watcher.context.validUntil! <= Date.now())) return;
      try { watcher.context.resourceOwner?.assertCurrent(); } catch { return; }
      for (const listener of this.listeners) listener(JSON.stringify({ jsonrpc: '2.0', method, params, [LOGICAL_CLIENT_FIELD]: watcher.clientId }));
    });
  }
  watchConversation(threadId: string, clientId: string, current: () => boolean): () => void {
    return this.inner?.watchConversation?.(threadId, clientId, current) ?? (() => {});
  }
  get status() { return this.inner.status; }
  connect(signal?: AbortSignal) { return this.inner.connect(signal); }
  close() { this.pending.clear(); this.watched.clear(); this.unsubscribeProcesses(); this.listeners.clear(); return this.inner.close(); }
  subscribeStatus(listener: Parameters<DuplexTransport['subscribeStatus']>[0]) { return this.inner.subscribeStatus(listener); }
  captureMessageScope() { return this.inner.captureMessageScope?.() ?? (() => this.inner.status.state === 'open'); }
  subscribeRecoveryHint(listener: () => void) { return this.inner.subscribeRecoveryHint?.(listener) ?? (() => {}); }
  subscribeMessage(listener: (frame: string) => void) {
    this.listeners.add(listener);
    const unsubscribe = this.inner.subscribeMessage(frame => {
      const value = object(JSON.parse(frame)), pending = this.pending.get(key(value));
      if (!value.method && pending) {
        this.pending.delete(key(value));
        if (!value.error) {
          const result = object(value.result), thread = object(result.thread);
          if (['thread/start', 'thread/fork', 'thread/resume', 'thread/read'].includes(pending.method) && typeof thread.id === 'string')
            this.runtime.bind(this.hostId, thread.id, typeof thread.projectId === 'string' ? thread.projectId : pending.projectId);
          if (pending.method === 'project/list' && Array.isArray(result.data)) this.runtime.rememberProjects(this.hostId, result.data);
          if (pending.method === 'project/create' && result.project) this.runtime.rememberProjects(this.hostId, [result.project]);
        }
      }
      delete value[EXECUTION_ENVIRONMENT_FIELD]; listener(JSON.stringify(value));
    });
    return () => { this.listeners.delete(listener); unsubscribe(); };
  }
  send(frame: string, signal?: AbortSignal) { return this.sendWithContext(frame, { sender: null }, signal); }
  async sendWithContext(frame: string, context: TransportSubmissionContext, signal?: AbortSignal) {
    const value = object(JSON.parse(frame)), params = object(value.params);
    delete value[EXECUTION_ENVIRONMENT_FIELD]; delete params[EXECUTION_ENVIRONMENT_FIELD];
    if (typeof value.method === 'string' && value.method.startsWith('process/')) {
      let response;
      try {
        const scope = this.runtime.scope(context, this.hostId, params);
        const result = await this.processes.dispatch(value.method, params, scope, () => { this.runtime.scope(context, this.hostId, params); }, () => {
          if (typeof params.processHandle === 'string' && value.method !== 'process/kill') this.watched.set(params.processHandle, { clientId: value[LOGICAL_CLIENT_FIELD], context });
        });
        context.resourceOwner?.assertCurrent();
        response = { ...value, method: undefined, params: undefined, result };
      } catch (error) { response = { ...value, method: undefined, params: undefined, error: { code: error instanceof TerminalCapacityError ? -32029 : -32602, message: error instanceof TerminalCapacityError ? error.message : 'Terminal unavailable for this account or project' } }; }
      for (const listener of this.listeners) listener(JSON.stringify(response));
      return;
    }
    let scope: EnvironmentExecutionScope | undefined;
    if (typeof value.method === 'string' && (['thread/start', 'thread/fork', 'thread/resume', 'turn/start', 'thread/queue/add', 'thread/queue/start'].includes(value.method) || value.method.startsWith('process/'))) {
      scope = this.runtime.scope(context, this.hostId, params);
      value.params = { ...params, [EXECUTION_ENVIRONMENT_FIELD]: this.runtime.seal(scope, value.method, params.processHandle) };
    }
    if (value.id !== undefined && ['thread/start', 'thread/fork', 'thread/resume', 'thread/read', 'project/list', 'project/create'].includes(value.method)) {
      if (this.pending.size >= 512) throw new Error('Environment request limit reached');
      this.pending.set(key(value), { method: value.method, projectId: scope?.projectId ?? (typeof params.projectId === 'string' ? params.projectId : typeof params.threadId === 'string' ? this.runtime.project(this.hostId, params.threadId) : null) });
    }
    const encoded = JSON.stringify(value);
    if (this.inner.sendWithContext) await this.inner.sendWithContext(encoded, context, signal); else await this.inner.send(encoded, signal);
  }
}
