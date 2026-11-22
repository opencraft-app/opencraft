import type { SandboxBrowserOwnerTransport } from './sandbox-browser-owner.js';
import type { WorkspaceExecutionSelection } from "@opencraft/sandbox-node/workspace-execution-channel";
import type { SandboxWorkspaceFiles } from './sandbox-workspace-files.js';
import type { SandboxProcessService } from './sandbox-process-service.js';
import { OrdinaryWorkspaceCompute, type WorkspaceAllocation } from './ordinary-workspace-compute.js';
import { OrdinaryWorkspaceStore, type WorkspaceAuthority, type WorkspaceLease } from './ordinary-workspace-store.js';
import { ordinaryWorkspaceCwd, encodeWorkspaceSelection, type ResolvedWorkspaceSelection } from './ordinary-workspace-selection.js';

export interface OrdinaryExecutionBinding {
  /** Synchronous incarnation liveness; not a substitute for business admission. */
  isCurrent?(): boolean;
  readonly files?: Pick<SandboxWorkspaceFiles, 'request'>;
  readonly processes?: SandboxProcessService;
  /** Private, incarnation-owned transport; no user-supplied sandbox/socket IDs. */
  readonly browser?: {
    assertCurrent(): void;
    connect(): Promise<SandboxBrowserOwnerTransport>;
  };
  registerExecutionEnvironment?(request: (method: string, params: Record<string, unknown>) => Promise<unknown>): Promise<void>;
  executionSelection?(): Promise<WorkspaceExecutionSelection>;
  bindThread?(threadId: string): Promise<void>;
  executionFields(): Promise<{ cwd: string; runtimeWorkspaceRoots: string[]; environments: { environmentId: string; cwd: string }[] }>;
  close(): Promise<void>;
}
export interface OrdinaryCreationOptions {
  /** Trusted admission identities, not wire metadata. */
  authority: WorkspaceAuthority;
  intentId: string;
  selection: ResolvedWorkspaceSelection;
  /** Reauthorizes the exact immutable catalog/source snapshot. */
  authorize(selection: ResolvedWorkspaceSelection): Promise<void>;
  allocate(lease: WorkspaceLease, selection: ResolvedWorkspaceSelection): Promise<WorkspaceAllocation>;
  /** Includes source preparation; must clean partial preparation on rejection. */
  prepare(allocation: WorkspaceAllocation, authorize: () => Promise<void>, context: {
    workspaceId: string; generation: number; environmentId: string; threadId?: string;
    /** The prepared transport must signal loss to invalidate/reclaim this incarnation. */
    onLost(): void;
  }): Promise<OrdinaryExecutionBinding>;
  /** Private Native route. Never implement this using a local-fallback transport. */
  nativeStart(fields: Awaited<ReturnType<OrdinaryExecutionBinding['executionFields']>>, binding: OrdinaryExecutionBinding): Promise<unknown>;
}

export interface OrdinaryRestoreOptions extends Omit<OrdinaryCreationOptions, 'intentId' | 'selection' | 'nativeStart'> {
  threadId: string;
  /** Read-only provider inspection. Never kill or adopt a live member here. */
  inspect(binding: { workspaceId: string; privateVolumeId: string }): Promise<'absent' | 'present' | 'unknown'>;
  nativeResume(threadId: string, fields: Awaited<ReturnType<OrdinaryExecutionBinding['executionFields']>>, binding: OrdinaryExecutionBinding): Promise<unknown>;
}

/** Host lifecycle composition. Product admission and the private Native route must
 * be installed by the deployment; constructing this class does not expose a UI
 * capability. Close this owner before closing its journal. No automatic replay. */
export interface OrdinaryThreadLifecycle {
  hostId: string; threadId: string; generation: number; state: 'active'|'archived'|'deleted';
}
type LifecycleEntry = {row: OrdinaryThreadLifecycle; pending: boolean; managed: boolean; ready: boolean; work: Promise<{managed:boolean}>};
export class OrdinaryConversationOwner {
  private readonly compute: OrdinaryWorkspaceCompute;
  private closed = false;
  private closing?: Promise<void>;
  private pending = new Set<Promise<unknown>>();
  private active = new Set<() => Promise<void>>();
  private cleanupFailed = false;
  private restoring = new Set<string>();
  private bindings = new Map<string, { binding: OrdinaryExecutionBinding; authorize(): Promise<void>; retire(): Promise<void> }>();
  private lifecycles = new Map<string, LifecycleEntry>();
  private pendingThreads = new Map<string, Set<Promise<unknown>>>();
  private assertThreadActive(hostId: string, threadId: string) {
    const current = this.lifecycles.get(JSON.stringify([hostId, threadId]));
    if (current && (!current.ready || current.pending || current.row.state !== 'active')) throw Error('Workspace conversation is retired');
  }
  private trackThread(authority: WorkspaceAuthority, threadId: string, work: Promise<unknown>) {
    const key = this.key(authority, threadId), pending = this.pendingThreads.get(key) ?? new Set();
    this.pendingThreads.set(key, pending); pending.add(work);
    const finish = () => {pending.delete(work); if (!pending.size && this.pendingThreads.get(key) === pending) this.pendingThreads.delete(key);};
    void work.then(finish, finish);
  }
  /** Canonical lifecycle is the Gateway's existing committed journal. This is
   * its private monotonic projection, not a second writable lifecycle ledger. */
  applyThreadLifecycle(row: OrdinaryThreadLifecycle): Promise<{managed:boolean}> {
    if (this.closed || !row || ![row.hostId,row.threadId].every(v => typeof v === 'string' && !!v && v.length <= 512 && !/[\x00-\x1f\x7f]/u.test(v))
      || !Number.isSafeInteger(row.generation) || row.generation < 1 || !['active','archived','deleted'].includes(row.state)) return Promise.reject(Error('Invalid workspace lifecycle'));
    const snapshot = {...row}, key = JSON.stringify([row.hostId,row.threadId]), prior = this.lifecycles.get(key);
    if (prior && (row.generation < prior.row.generation || row.generation === prior.row.generation && row.state !== prior.row.state
      || prior.row.state === 'deleted' && row.state !== 'deleted')) return Promise.reject(Error('Stale workspace lifecycle'));
    if (prior && row.generation === prior.row.generation) {
      if (prior.pending || prior.managed) return prior.work;
      // A late positive Native receipt may have arrived after the first cleanup
      // observation. Recheck committed idle proof; never replay physical close.
      const rows = this.store.lifecycleForThread(row.hostId,row.threadId);
      if (!rows.length) return Promise.resolve({managed:false});
      if (rows.some(r => r.phase !== 'idle')) return Promise.reject(Error('Workspace cleanup requires reconciliation'));
      prior.managed = true; prior.ready = true; prior.work = Promise.resolve({managed:true}); return prior.work;
    }
    if (!prior && this.lifecycles.size >= 100000) return Promise.reject(Error('Too many workspace lifecycle scopes'));
    const entry: LifecycleEntry = {row:snapshot,pending:true,managed:false,ready:false,work:undefined!};
    this.lifecycles.set(key,entry); // Fence before any await or teardown.
    const matches = (bindingKey: string) => {const value = JSON.parse(bindingKey);return value[1] === snapshot.hostId && value[2] === snapshot.threadId;};
    entry.work = (async()=>{
      // A newer committed generation cannot overtake an earlier physical close.
      // Its result may be unknown, but it must not run a second destroy attempt.
      if (prior) await prior.work.catch(()=>{});
      await Promise.allSettled([...this.pendingThreads].filter(([k])=>matches(k)).flatMap(([,pending])=>[...pending]));
      const owned = [...this.bindings].filter(([k])=>matches(k)).map(([,value])=>value);
      entry.managed = owned.length > 0;
      const outcomes = await Promise.allSettled(owned.map(value=>value.retire()));
      if (outcomes.some(r=>r.status === 'rejected')) throw Error('Workspace cleanup unconfirmed');
      const rows = this.store.lifecycleForThread(snapshot.hostId,snapshot.threadId);
      entry.managed ||= rows.length > 0;
      if (rows.some(r=>r.phase !== 'idle')) throw Error('Retained workspace requires reconciliation');
      entry.ready = entry.managed;
      return {managed:entry.managed};
    })().finally(()=>{entry.pending = false;});
    return entry.work;
  }
  private key(authority: WorkspaceAuthority, threadId: string) { return JSON.stringify([authority.principalId, authority.hostId, threadId]); }
  /** Internal execution router only. Missing/restored bindings fail closed. */
  async bindingFor(authority: WorkspaceAuthority, threadId: string): Promise<OrdinaryExecutionBinding> {
    this.assertThreadActive(authority.hostId, threadId);
    const key = this.key(authority, threadId), current = this.bindings.get(key);
    if (!current) throw Error('Ordinary execution binding unavailable');
    await current.authorize();
    if (this.bindings.get(key) !== current) throw Error('Ordinary execution binding expired');
    return current.binding;
  }
  constructor(private readonly store: OrdinaryWorkspaceStore) { this.compute = new OrdinaryWorkspaceCompute(store); }

  start(options: OrdinaryCreationOptions): Promise<{ workspaceId: string; threadId: string }> {
    // Copy before the first await: later mutation of a request cannot change identity.
    const authority = { ...options.authority }, intentId = options.intentId;
    let executionLost = false, knownThreadId: string | undefined;
    const snapshot = encodeWorkspaceSelection(options.selection).json;
    const selection = () => JSON.parse(snapshot) as ResolvedWorkspaceSelection;
    const authorize = async () => {
      if (this.closed) throw Error('Ordinary conversation owner closed');
      if (executionLost) throw Error('Ordinary execution transport lost');
      if (knownThreadId) this.assertThreadActive(authority.hostId, knownThreadId);
      await options.authorize(selection());
      if (this.closed) throw Error('Ordinary conversation owner closed');
      if (executionLost) throw Error('Ordinary execution transport lost');
      if (knownThreadId) this.assertThreadActive(authority.hostId, knownThreadId);
    };
    // The operation is assigned before the first authorization await can resume.
    let operation!: Promise<{workspaceId:string;threadId:string}>;
    operation = (async () => {
      await authorize();
      const admitted = this.store.admitResolved(authority, intentId, selection());
      // A successful duplicate returns its receipt, not another thread/start.
      // Restoring execution for that existing thread is a separate operation.
      if (admitted.threadId) { this.assertThreadActive(authority.hostId, admitted.threadId); return { workspaceId: admitted.workspaceId, threadId: admitted.threadId }; }
      let allocation: WorkspaceAllocation | undefined, binding: OrdinaryExecutionBinding | undefined;
      let cleanup: Promise<void> | undefined, bindingKey: string | undefined, published = false;
      const retire = () => cleanup ??= (async () => {
        // Bridge/process teardown precedes releasing compute, but a bridge error
        // must not prevent attempting exact-instance deletion.
        if (bindingKey) this.bindings.delete(bindingKey);
        let failed = false;
        try { await binding?.close(); } catch { failed = true; }
        try { await allocation?.close(); } catch { failed = true; }
        this.active.delete(retire);
        if (failed) { this.cleanupFailed = true; throw Error('Ordinary conversation cleanup unconfirmed'); }
      })();
      try {
        let lease!: WorkspaceLease;
        allocation = await this.compute.create({ authority, workspaceId: admitted.workspaceId, authorize,
          allocate: async claimed => { lease = claimed; return options.allocate(claimed, selection()); } });
        binding = await options.prepare(allocation, authorize, { workspaceId: admitted.workspaceId, generation: lease.generation, environmentId: "workspace-" + admitted.workspaceId,
          onLost: () => { executionLost = true; if (published) void retire().catch(() => {}); },
        });
        await authorize();
        const fields = await binding.executionFields();
        // Prevent an incorrectly wired binding from silently requesting local execution.
        const expectedCwd = ordinaryWorkspaceCwd(selection());
        if (fields.cwd !== expectedCwd || fields.runtimeWorkspaceRoots.length !== 1
          || fields.runtimeWorkspaceRoots[0] !== expectedCwd || fields.environments.length !== 1
          || fields.environments[0].environmentId !== "workspace-" + admitted.workspaceId
          || fields.environments[0].cwd !== expectedCwd) throw Error('Invalid ordinary execution binding');
        await authorize();
        this.store.beginThreadStart(authority, lease);
        const response = await options.nativeStart(fields, binding);
        const threadId = (response as { thread?: { id?: unknown } } | null)?.thread?.id;
        if (typeof threadId !== 'string' || !threadId) throw Error('Native thread creation receipt missing');
        knownThreadId = threadId;
        this.trackThread(authority, threadId, operation);
        // Persist positive evidence even when auth/shutdown changed during the RPC.
        this.store.confirmThreadStarted(authority, lease, threadId);
        await authorize();
        await binding.bindThread?.(threadId);
        await authorize();
        bindingKey = this.key(authority, threadId);
        this.bindings.set(bindingKey, { binding, authorize, retire });
        this.active.add(retire); published = true;
        return { workspaceId: admitted.workspaceId, threadId };
      } catch (error) {
        try { await retire(); } catch { throw new AggregateError([error], 'Ordinary creation failed; cleanup unconfirmed'); }
        throw error;
      }
    })();
    this.pending.add(operation);
    void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation));
    return operation;
  }

  /** Restores execution, never creates/replaces the Native thread or its volume.
   * The stored exact selection must still be authorized; no latest-template/ref
   * substitution. Native sticky environment identity is stable across generations. */
  restore(options: OrdinaryRestoreOptions): Promise<{ workspaceId: string; threadId: string }> {
    const authority = { ...options.authority }, threadId = options.threadId;
    const key = this.key(authority, threadId);
    const operation = (async () => {
      if (this.closed) throw Error('Ordinary conversation owner closed');
      const row = this.store.forThread(authority, threadId);
      if (!row) throw Error('Ordinary workspace binding not found');
      let executionLost = false;
      const snapshot = encodeWorkspaceSelection(this.store.resolvedSelection(authority, row.workspaceId)).json;
      const selection = () => JSON.parse(snapshot) as ResolvedWorkspaceSelection;
      const authorize = async () => {
        if (this.closed) throw Error('Ordinary conversation owner closed');
        if (executionLost) throw Error('Ordinary execution transport lost');
        this.assertThreadActive(authority.hostId, threadId);
        await options.authorize(selection());
        if (this.closed) throw Error('Ordinary conversation owner closed');
        if (executionLost) throw Error('Ordinary execution transport lost');
        this.assertThreadActive(authority.hostId, threadId);
      };
      await authorize();
      if (this.bindings.has(key)) {
        await this.bindingFor(authority, threadId);
        return { workspaceId: row.workspaceId, threadId };
      }
      if (this.restoring.has(key)) throw Error('Ordinary workspace restore already pending');
      this.restoring.add(key);
      let allocation: WorkspaceAllocation | undefined, binding: OrdinaryExecutionBinding | undefined;
      let cleanup: Promise<void> | undefined, published = false;
      const retire = () => cleanup ??= (async () => {
        this.bindings.delete(key);
        let failed = false;
        try { await binding?.close(); } catch { failed = true; }
        try { await allocation?.close(); } catch { failed = true; }
        this.active.delete(retire);
        if (failed) { this.cleanupFailed = true; throw Error('Ordinary conversation cleanup unconfirmed'); }
      })();
      try {
        await this.compute.reconcileRetained({ authority, workspaceId: row.workspaceId, authorize, inspect: options.inspect });
        let claimedLease!: WorkspaceLease;
        allocation = await this.compute.create({ authority, workspaceId: row.workspaceId, authorize,
          allocate: lease => { claimedLease = lease; return options.allocate(lease, selection()); } });
        binding = await options.prepare(allocation, authorize, {
          workspaceId: row.workspaceId, generation: claimedLease.generation, environmentId: 'workspace-' + row.workspaceId, threadId,
          onLost: () => { executionLost = true; if (published) void retire().catch(() => {}); },
        });
        await authorize();
        const fields = await binding.executionFields();
        const expectedCwd = ordinaryWorkspaceCwd(selection());
        if (fields.cwd !== expectedCwd || fields.runtimeWorkspaceRoots.length !== 1
          || fields.runtimeWorkspaceRoots[0] !== expectedCwd || fields.environments.length !== 1
          || fields.environments[0].environmentId !== 'workspace-' + row.workspaceId
          || fields.environments[0].cwd !== expectedCwd) throw Error('Invalid ordinary execution binding');
        await authorize();
        const response = await options.nativeResume(threadId, fields, binding);
        if ((response as { thread?: { id?: unknown } } | null)?.thread?.id !== threadId)
          throw Error('Native resume receipt conflict');
        await authorize();
        await binding.bindThread?.(threadId);
        await authorize();
        this.bindings.set(key, { binding, authorize, retire });
        this.active.add(retire); published = true;
        return { workspaceId: row.workspaceId, threadId };
      } catch (error) {
        try { await retire(); } catch { throw new AggregateError([error], 'Ordinary restore failed; cleanup unconfirmed'); }
        throw error;
      } finally { this.restoring.delete(key); }
    })();
    this.pending.add(operation);
    this.trackThread(authority, threadId, operation);
    void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation));
    return operation;
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.closed = true;
      await Promise.allSettled([...this.pending]);
      await Promise.allSettled([...this.active].map(retire => retire()));
      await this.compute.close();
      if (this.cleanupFailed) throw Error('Ordinary conversation cleanup unconfirmed');
    })();
  }
}
