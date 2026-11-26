import type { DuplexTransport, TransportSubmissionContext } from '@opencraft/appserver-client/transport';
import { LOGICAL_CLIENT_FIELD } from '@opencraft/app-host-protocol';
import { EXECUTION_ENVIRONMENT_FIELD, requiresEnvironmentAuthority, type ExecutionEnvironmentRuntime, type EnvironmentExecutionScope } from '@opencraft/execution-environment';
import { TerminalCapacityError } from '@opencraft/local-agent-host/process-service';
import { DurableHostProcessService } from '@opencraft/local-agent-host/durable-process-service';
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
  private readonly unsubscribeInner: () => void;
  private readonly pending = new Map<string, { method: string; projectId: string | null; creation?: EnvironmentExecutionScope }>();
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
    this.unsubscribeInner = this.inner.subscribeMessage(frame => this.receive(frame));
  }
  get status() { return this.inner.status; }
  connect(signal?: AbortSignal) { return this.inner.connect(signal); }
  close() { this.pending.clear(); this.watched.clear(); this.unsubscribeProcesses(); this.unsubscribeInner(); this.listeners.clear(); return this.inner.close(); }
  subscribeStatus(listener: Parameters<DuplexTransport['subscribeStatus']>[0]) { return this.inner.subscribeStatus(listener); }
  captureMessageScope() { return this.inner.captureMessageScope?.() ?? (() => this.inner.status.state === 'open'); }
  subscribeRecoveryHint(listener: () => void) { return this.inner.subscribeRecoveryHint?.(listener) ?? (() => {}); }
  subscribeMessage(listener: (frame: string) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private receive(frame: string) {
    const value = object(JSON.parse(frame)), pending = this.pending.get(key(value));
    if (!value.method && pending) {
      this.pending.delete(key(value));
      if (!value.error) {
        const result = object(value.result), thread = object(result.thread);
        if (pending.creation && typeof thread.id === 'string') {
          try { this.runtime.bindCreator(pending.creation, thread.id); }
          catch {
            const rejected = JSON.stringify({ ...value, result: undefined, error: { code: -32000, message: 'Unable to bind task credentials' } });
            for (const listener of this.listeners) listener(rejected);
            return;
          }
        }
        if (['thread/start', 'thread/fork', 'thread/resume', 'thread/read'].includes(pending.method) && typeof thread.id === 'string')
          this.runtime.bind(this.hostId, thread.id, typeof thread.projectId === 'string' ? thread.projectId : pending.projectId);
        if (pending.method === 'project/list' && Array.isArray(result.data)) this.runtime.rememberProjects(this.hostId, result.data);
        if (pending.method === 'project/create' && result.project) this.runtime.rememberProjects(this.hostId, [result.project]);
      }
    }
    delete value[EXECUTION_ENVIRONMENT_FIELD];
    const encoded = JSON.stringify(value);
    for (const listener of this.listeners) listener(encoded);
  }
  send(frame: string, signal?: AbortSignal) { return this.sendWithContext(frame, { sender: null }, signal); }
  private rejectBeforeDelivery(value: Record<string, any>, error: unknown) {
    // Only failures before inner.send are known not to have been submitted.
    // Never turn an uncertain transport delivery into a safe-to-retry rejection.
    if (value.id === undefined) throw error;
    const response = { jsonrpc: '2.0', id: value.id, [LOGICAL_CLIENT_FIELD]: value[LOGICAL_CLIENT_FIELD],
      error: { code: -32602, message: 'This message was not sent. Check your access and try again.',
        data: { notSubmitted: true, submissionOutcome: 'rejected', retryable: false } } };
    for (const listener of this.listeners) listener(JSON.stringify(response));
  }
  async sendWithContext(frame: string, context: TransportSubmissionContext, signal?: AbortSignal) {
    const value = object(JSON.parse(frame)), params = object(value.params);
    delete value[EXECUTION_ENVIRONMENT_FIELD]; delete params[EXECUTION_ENVIRONMENT_FIELD];
    // Collaboration queue admission is authorized from the durable request
    // ledger by the Host (including the original submitter, binding and
    // expiry). It only records an input; it must not borrow the creator's
    // environment credentials before a Host turn admission exists.
    const collaborationQueueAdmission = value.method === 'thread/queue/add'
      && typeof context.collaborationRequestId === 'string'
      && params.clientUserMessageId === `actor-input:${context.collaborationRequestId}`;
    try {
      if (typeof value.method === 'string' && requiresEnvironmentAuthority(value.method, context.collaborationRequestId) && !collaborationQueueAdmission) this.runtime.scope(context, this.hostId, params);
    } catch {
      // This check precedes every native dispatch. Report only a known rejection,
      // not a delivery failure or an invitation to reconnect/replay. Keep logical
      // routing, but never echo request payloads or private authority errors.
      if (value.id !== undefined) {
        const response = {
          ...(value.jsonrpc === '2.0' ? { jsonrpc: '2.0' } : {}), id: value.id,
          ...(value[LOGICAL_CLIENT_FIELD] === undefined ? {} : { [LOGICAL_CLIENT_FIELD]: value[LOGICAL_CLIENT_FIELD] }),
          error: { code: -32602, message: 'This message was not sent. Check your access and try again.',
            data: { notSubmitted: true, submissionOutcome: 'rejected', retryable: false } },
        };
        for (const listener of this.listeners) listener(JSON.stringify(response));
      }
      return;
    }
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
    try {
      let scope: EnvironmentExecutionScope | undefined;
      if (typeof value.method === 'string' && ['thread/start', 'thread/fork', 'turn/start', 'thread/queue/add', 'thread/queue/start'].includes(value.method) && !collaborationQueueAdmission) {
        // Fork creates an independent task for its authenticated creator. Never
        // inherit the source task's credential identity or private env snapshot.
        const creationParams = value.method === 'thread/fork' ? { projectId: typeof params.threadId === 'string' ? this.runtime.project(this.hostId, params.threadId) : null } : params;
        scope = this.runtime.scope(context, this.hostId, creationParams);
        value.params = { ...params, [EXECUTION_ENVIRONMENT_FIELD]: this.runtime.seal(scope, value.method, params.processHandle) };
      }
      if (value.id !== undefined && ['thread/start', 'thread/fork', 'thread/resume', 'thread/read', 'project/list', 'project/create'].includes(value.method)) {
        if (this.pending.size >= 512) throw new Error('Environment request limit reached');
        this.pending.set(key(value), { method: value.method, projectId: scope?.projectId ?? (typeof params.projectId === 'string' ? params.projectId : typeof params.threadId === 'string' ? this.runtime.project(this.hostId, params.threadId) : null),
          ...(['thread/start', 'thread/fork'].includes(value.method) && scope ? { creation: scope } : {}) });
      }
    } catch (error) { this.pending.delete(key(value)); this.rejectBeforeDelivery(value, error); return; }
    const encoded = JSON.stringify(value);
    try {
      if (this.inner.sendWithContext) await this.inner.sendWithContext(encoded, context, signal); else await this.inner.send(encoded, signal);
    } catch (error) { this.pending.delete(key(value)); throw error; }
  }
}
