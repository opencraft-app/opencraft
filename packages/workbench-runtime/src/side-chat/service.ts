import { ResourceDirectoryReconciler } from '../resource-directory-reconciler';
import { Context, Service } from "@deepseek-ai/cordis";
import { createConversationKey, encodeConversationKey, independentConversationOwnership, type ConversationKey, type ConversationOwnership } from "@opencraft/chat-core";
import { createComposerController, retargetSubmitIntentForFollowUp, type ComposerController, type ComposerFollowUpAction, type SubmitIntent } from "@opencraft/composer-core";
import { sideChatDirectoryBinding, type SideChatDirectoryRow, type SideChatRecord } from "./records";
export type { SideChatRecord } from "./records";
import type { AppServerThreadRuntimeLease, AppServerWorkbenchRuntime } from "../appserver-runtime";

export { SIDE_CHAT_INSTRUCTIONS, SIDE_CHAT_BOUNDARY } from "./policy";

export interface SideChatSession {
  readonly id: string;
  readonly parent: ConversationKey;
  readonly key: ConversationKey;
  readonly lease: AppServerThreadRuntimeLease;
  readonly composer: ComposerController;
}
/** References only. The Host remains authoritative for history and admission. */
export interface SideChatPersistence {
  /** Account-scoped references, including known bindings of closed children. */
  directory?(): readonly SideChatDirectoryRow[];
  list(parent: ConversationKey): readonly SideChatRecord[];
  put(record: SideChatRecord): void | Promise<void>;
  remove(id: string, binding?: SideChatRecord): void | Promise<void>;
  ready?(): Promise<void>;
  subscribe?(listener: () => void): () => void;
  /** Unscoped pre-sync references require an authorized child-history read. */
  legacy?(parent: ConversationKey): readonly SideChatRecord[];
  forgetLegacy?(id: string): void;
}
export interface SideChatConfig {
  resolveHost(hostId: string): Promise<AppServerWorkbenchRuntime>;
  persistence?: SideChatPersistence;
}
declare module "@deepseek-ai/cordis" { interface Context { sideChats: SideChatService } }

/** Application-owned child conversations. A tab/view is only a consumer. */
export class SideChatService extends Service {
  private readonly sessions = new Map<string, SideChatSession>();
  private readonly creatingChildren = new Map<string, SideChatRecord>();
  // Embedders without a directory still own their closed children for this
  // application lifetime. The Web directory remains the durable authority.
  private readonly retainedBindings = new Map<string, SideChatRecord>();
  private catalogOwners = new Map<string, ConversationOwnership>();
  ownershipOf(key: ConversationKey): ConversationOwnership {
    return this.catalogOwners.get(encodeConversationKey(key)) ?? independentConversationOwnership;
  }
  private refreshOwnership(): void {
    const owners = new Map<string, ConversationOwnership>();
    const records = [
      ...(this.config.persistence?.directory?.() ?? []).flatMap(row => {
        const binding = sideChatDirectoryBinding(row);
        return binding ? [binding] : [];
      }),
      ...[...this.creationFailures.values()].flatMap(failure => failure.session ? [failure.session] : []), ...this.retainedBindings.values(), ...this.creatingChildren.values(), ...this.sessions.values(), ...[...this.cleanup.values()].map(row => row.record),
    ];
    for (const record of records) owners.set(encodeConversationKey(record.key), { kind: 'side-chat', owner: record.parent });
    this.catalogOwners = owners;
  }
  private readonly creationFailures = new Map<string, { parent: ConversationKey; cwd: string | null; error: Error; session?: SideChatSession; runtime?: AppServerWorkbenchRuntime }>();
  getCreationError(id: string): Error | null { return this.creationFailures.get(id)?.error ?? null; }
  async retryCreation(id: string): Promise<void> {
    const failure = this.creationFailures.get(id);
    if (!failure || this.pending.has(id)) return;
    if (!failure.session) {
      if (this.cleanup.has(id)) await this.close(id);
      this.retired.delete(id); this.creationFailures.delete(id);
      await this.open(id, failure.parent, failure.cwd); return;
    }
    const attempt = {}; this.pending.set(id, attempt); this.publish();
    try {
      await this.config.persistence?.ready?.();
      await this.config.persistence?.put({ id, parent: failure.session.parent, key: failure.session.key });
      if (this.disposed || this.pending.get(id) !== attempt) return;
      this.sessions.set(id, failure.session); this.hostRuntimes.set(id, failure.runtime!);
      this.creationFailures.delete(id);
    } catch (error) { failure.error = error instanceof Error ? error : new Error(String(error)); throw error; }
    finally { if (this.pending.get(id) === attempt) this.pending.delete(id); this.publish(); }
  }
  private readonly pendingParents = new Map<string, ConversationKey>();
  pendingIds(parent: ConversationKey): string[] { return [...this.pendingParents].filter(([id, value]) => (this.pending.has(id) || this.creationFailures.has(id)) && value.hostId === parent.hostId && value.threadId === parent.threadId).map(([id]) => id); }
  private readonly pending = new Map<string, object>();
  private readonly hostRuntimes = new Map<string, AppServerWorkbenchRuntime>();
  private readonly closing = new Map<string, Promise<void>>();
  private readonly cleanup = new Map<string, { record: SideChatRecord; threadId: string; lease: AppServerThreadRuntimeLease | null; runtime: AppServerWorkbenchRuntime | null | undefined; interrupted: boolean; released: boolean; error?: unknown }>();
  private readonly parents = new Map<string, ConversationKey>();
  private revision = 0;
  private readonly recoveryErrors = new Map<string, Error>();
  getRevision = (): number => this.revision;
  getRecoveryError(id: string): Error | null { return this.recoveryErrors.get(id) ?? null; }
  records(parent: ConversationKey): readonly SideChatRecord[] {
    const rows = new Map((this.config.persistence?.list(parent) ?? []).filter(row => !this.retired.has(row.id)).map(row => [row.id, row]));
    for (const session of this.list(parent)) rows.set(session.id, session);
    return [...rows.values()];
  }
  private readonly listeners = new Set<() => void>();
  private readonly restores = new ResourceDirectoryReconciler();
  private readonly retired = new Set<string>();
  private disposed = false;
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private publish(): void { this.refreshOwnership(); this.revision++; for (const listener of this.listeners) listener(); }
  private watch(parent: ConversationKey): void { this.parents.set(encodeConversationKey(parent), parent); }
  private reconcile(): void {
    if (this.disposed) return;
    for (const parent of this.parents.values()) {
      const ids = new Set(this.config.persistence?.list(parent).map(row => row.id));
      for (const session of this.list(parent)) if (!ids.has(session.id) && !this.closing.has(session.id)) {
        // A remote close is already owned elsewhere: detach, never interrupt
        // another client's work or echo an unsubscribe/close transaction.
        this.retired.add(session.id); session.composer.dispose(); session.lease.release();
        this.sessions.delete(session.id); this.hostRuntimes.delete(session.id); this.recoveryErrors.delete(session.id);
      }
      void this.restore(parent).catch(() => { /* Retry through owner hydration/reconnect. */ });
    }
    this.publish();
  }
  /** Recover the exact durable child; never fork or reinject a boundary here. */
  async restore(parent: ConversationKey): Promise<void> {
    if (this.disposed) return;
    this.watch(parent);
    const parentId = encodeConversationKey(parent);
    await this.restores.invalidate(parentId, async () => {
      await this.config.persistence?.ready?.();
      if (this.disposed) return;
      const legacy = new Map((this.config.persistence?.legacy?.(parent) ?? []).map(row => [row.id, row]));
      const records = new Map([...legacy, ...this.records(parent).map(row => [row.id, row] as const)]);
      for (const record of records.values()) {
        if (this.disposed) return;
        if (record.parent.hostId !== parent.hostId || record.parent.threadId !== parent.threadId
          || record.key.hostId !== parent.hostId || record.key.threadId === parent.threadId
          || this.sessions.has(record.id) || this.retired.has(record.id) || this.creationFailures.has(record.id) || this.pending.has(record.id)) continue;
        try {
          this.recoveryErrors.delete(record.id);
          const runtime = await this.config.resolveHost(parent.hostId);
          if (this.disposed || this.retired.has(record.id)) continue;
          const lease = await runtime.acquireThread(record.key.threadId);
          if (legacy.has(record.id)) {
            try {
              // Never upload a former browser-local reference into an account
              // until that account can read the original durable child.
              await lease.retryRestore();
              if (!lease.getSnapshot().authoritative || lease.getSnapshot().error) throw new Error('Side chat migration requires authorized history');
              if (this.disposed || this.retired.has(record.id)) { lease.release(); continue; }
              await this.config.persistence?.put(record);
              this.config.persistence?.forgetLegacy?.(record.id);
            } catch (error) { lease.release(); throw error; }
          }
          if (this.disposed || this.retired.has(record.id) || this.sessions.has(record.id) || this.pending.has(record.id)
            || (!legacy.has(record.id) && this.config.persistence && !this.config.persistence.list(parent).some(row => row.id === record.id))) { lease.release(); continue; }
          this.sessions.set(record.id, { ...record, composer: createComposerController({ type: "existing-thread", key: record.key }, { now: Date.now, createId: () => crypto.randomUUID() }), lease });
          this.hostRuntimes.set(record.id, runtime);
          this.publish();
        } catch (error) {
          if (!this.disposed && !this.retired.has(record.id)) {
            this.recoveryErrors.set(record.id, error instanceof Error ? error : new Error(String(error)));
            this.publish();
          }
        }
      }
    });
  }
  constructor(ctx: Context, private readonly config: SideChatConfig) {
    super(ctx, "sideChats");
    this.refreshOwnership();
    const releaseDirectory = config.persistence?.subscribe?.(() => this.reconcile());
    ctx.effect(() => async () => {
      releaseDirectory?.();
      this.disposed = true;
      this.pending.clear(); this.pendingParents.clear(); this.restores.dispose();
      // Application teardown is a detach, not an explicit user close. Durable
      // children and active work must survive the disappearance of their view.
      for (const session of this.sessions.values()) { session.composer.dispose(); session.lease.release(); }
      for (const failure of this.creationFailures.values()) { failure.session?.composer.dispose(); failure.session?.lease.release(); }
      this.creationFailures.clear();
      this.sessions.clear(); this.hostRuntimes.clear(); this.listeners.clear();
      await Promise.allSettled([...this.cleanup.keys()].map(id => this.close(id)));
      await Promise.allSettled([...this.closing.values()]);
    });
  }
  get(id: string): SideChatSession | null { return this.sessions.get(id) ?? null; }
  list(parent: ConversationKey): readonly SideChatSession[] {
    return [...this.sessions.values()].filter(session => session.parent.hostId === parent.hostId && session.parent.threadId === parent.threadId);
  }
  hasContent(id: string): boolean {
    const session = this.get(id);
    return Boolean(session && (session.composer.getSnapshot().hasContent || session.lease.getSnapshot().timeline.frames.length > 0));
  }
  async open(id: string, parent: ConversationKey, cwd: string | null): Promise<SideChatSession> {
    if (this.disposed || this.retired.has(id) || this.pending.has(id) || this.sessions.has(id) || this.creationFailures.has(id) || this.cleanup.has(id)) throw new Error("Side chat identity is unavailable");
    this.watch(parent);
    const attempt = {};
    this.pending.set(id, attempt); this.pendingParents.set(id, parent);
    const current = () => !this.disposed && this.pending.get(id) === attempt;
    let runtime: AppServerWorkbenchRuntime | null = null;
    let childId: string | null = null;
    let lease: AppServerThreadRuntimeLease | null = null;
    let committed = false;
    let prepared: SideChatSession | undefined;
    try {
      await this.config.persistence?.ready?.();
      if (!current()) throw new Error("Side chat creation was cancelled");
      runtime = await this.config.resolveHost(parent.hostId);
      if (!current()) throw new Error("Side chat creation was cancelled");
      const boundary = runtime.resources.threads.sideChatBoundary?.(parent.threadId) ?? (runtime.resources.threads.sideChatBoundary ? null : "inject-items");
      if (!runtime.resources.threads.fork || !runtime.resources.threads.unsubscribe || boundary === null
        || (boundary === "inject-items" && !runtime.resources.threads.injectItems)
        || (boundary === "thread-settings" && !runtime.resources.threads.configureSideChat)
        || runtime.resources.threads.supportsSideChat?.(parent.threadId) === false) throw new Error("This host does not support recoverable side chats");
      const { SIDE_CHAT_INSTRUCTIONS, SIDE_CHAT_BOUNDARY } = await import("./policy");
      if (!current()) throw new Error("Side chat creation was cancelled");
      const child = await runtime.resources.threads.fork({ threadId: parent.threadId, workspaceFork: { kind: "side-chat", intentId: id }, cwd, ephemeral: false, excludeTurns: true, deferGoalContinuation: true, developerInstructions: SIDE_CHAT_INSTRUCTIONS }, { deduplicate: false, ownership: { kind: 'side-chat', owner: parent } });
      childId = child.id;
      this.creatingChildren.set(id, { id, parent, key: createConversationKey(parent.hostId, child.id) });
      this.publish();
      if (!current()) throw new Error("Side chat creation was cancelled");
      if (boundary === "thread-settings") await runtime.resources.threads.configureSideChat!(child.id, SIDE_CHAT_INSTRUCTIONS);
      if (boundary === "inject-items") await runtime.resources.threads.injectItems!(child.id, [{ type: "message", role: "user", content: [{ type: "input_text", text: SIDE_CHAT_BOUNDARY }] }]);
      if (!current()) throw new Error("Side chat creation was cancelled");
      lease = await runtime.acquireThread(child.id);
      if (!current()) throw new Error("Side chat creation was cancelled");
      const key = createConversationKey(parent.hostId, child.id);
      prepared = { id, parent, key, lease, composer: createComposerController({ type: "existing-thread", key }, { now: Date.now, createId: () => crypto.randomUUID() }) };
      await this.config.persistence?.put({ id, parent, key });
      committed = this.config.persistence !== undefined;
      if (!current()) throw new Error("Side chat creation was cancelled");
      const session = prepared;
      this.sessions.set(id, session);
      this.hostRuntimes.set(id, runtime);
      this.publish();
      return session;
    } catch (error) {
      // The Server accepted a discoverable resource before application teardown.
      // A refresh detaches this reader; it must not broadcast a destructive close.
      if (committed && this.disposed) { prepared?.composer.dispose(); lease?.release(); throw error; }
      if (!this.disposed && current()) {
        this.creationFailures.set(id, { parent, cwd, error: error instanceof Error ? error : new Error(String(error)), session: prepared, runtime: runtime ?? undefined });
      }
      if (prepared && !this.disposed && current()) throw error;
      prepared?.composer.dispose();
      if (childId !== null) {
        this.cleanup.set(id, { record: { id, parent, key: createConversationKey(parent.hostId, childId) }, threadId: childId, lease, runtime, interrupted: false, released: false });
        void this.close(id, true).catch(() => { /* Cleanup remains owned; never delay the original creation error. */ });
      } else lease?.release();
      throw error;
    } finally {
      if (this.pending.get(id) === attempt) this.pending.delete(id);
      if (!this.creationFailures.has(id)) this.pendingParents.delete(id); this.creatingChildren.delete(id); this.publish();
    }
  }
  cancel(id: string): void { this.pending.delete(id); this.pendingParents.delete(id); }
  pendingCleanup(): ReadonlyArray<{ id: string; threadId: string; error: unknown }> {
    return [...this.cleanup].map(([id, record]) => ({ id, threadId: record.threadId, error: record.error ?? null }));
  }
  async submit(id: string, submitted: SubmitIntent, followUp: ComposerFollowUpAction | null): Promise<void> {
    const session = this.get(id);
    if (!session) throw new Error("Side chat is closed");
    if (submitted.target.type !== "existing-thread" || submitted.target.key.hostId !== session.key.hostId || submitted.target.key.threadId !== session.key.threadId) {
      throw new Error("Side chat submission targets a different conversation");
    }
    // The editor has already frozen this intent before entering `submitting`.
    // Never re-read/re-freeze an editable draft across that boundary.
    let intent = submitted;
    const active = session.lease.getSnapshot().activeTurn;
    if (active) {
      if (followUp === "queue") throw new Error("Side chats do not support queued follow-ups. Use steer or wait for the response.");
      intent = retargetSubmitIntentForFollowUp(intent, session.key, active.turnId, "steer");
    }
    await session.lease.submit(intent);
  }
  async close(id: string, preserveCreationError = false): Promise<void> {
    const pendingClose = this.closing.get(id);
    if (pendingClose) return pendingClose;
    const operation = this.closeOwned(id, preserveCreationError);
    this.closing.set(id, operation);
    try { await operation; }
    catch (error) {
      if (this.sessions.has(id)) { this.recoveryErrors.set(id, error instanceof Error ? error : new Error(String(error))); this.publish(); }
      throw error;
    } finally { if (this.closing.get(id) === operation) this.closing.delete(id); }
  }
  private async closeOwned(id: string, preserveCreationError: boolean): Promise<void> {
    // Remove the recovery reference before releasing a live resource. Failure
    // leaves the visible session intact so the user can retry the close.
    const failedRuntime = this.creationFailures.get(id)?.runtime;
    const failedSession = this.creationFailures.get(id)?.session;
    const binding = this.sessions.get(id) ?? failedSession ?? this.creatingChildren.get(id) ?? this.cleanup.get(id)?.record;
    await this.config.persistence?.remove(id, binding);
    if (!this.config.persistence?.directory && binding) this.retainedBindings.set(id, { id, parent: binding.parent, key: binding.key });
    this.retired.add(id);
    this.recoveryErrors.delete(id);
    if (!preserveCreationError) this.creationFailures.delete(id);
    this.publish();
    if (!preserveCreationError) this.cancel(id);
    let cleanup = this.cleanup.get(id);
    if (!cleanup) {
      const session = this.get(id) ?? failedSession;
      if (!session) return;
      cleanup = { record: session, threadId: session.key.threadId, lease: session.lease, runtime: this.hostRuntimes.get(id) ?? failedRuntime, interrupted: false, released: false };
      this.cleanup.set(id, cleanup);
      this.sessions.delete(id);
      this.hostRuntimes.delete(id);
      session.composer.dispose();
      this.publish();
    }
    const owned = cleanup;
    const operation = (async () => {
      if (!owned.interrupted) {
        const active = owned.lease?.getSnapshot().activeTurn;
        try {
          if (active) await owned.lease!.interrupt(active.turnId, {
            source: "side-chat-close",
            trigger: "programmatic",
            isTrusted: null,
            occurredAt: Date.now(),
          });
          owned.interrupted = true;
        }
        catch (error) { owned.error = error; }
      }
      if (!owned.released) { owned.lease?.release(); owned.released = true; }
      await owned.runtime?.resources.threads.unsubscribe?.(owned.threadId);
      if (this.cleanup.get(id) === owned) this.cleanup.delete(id);
    })();
    try { await operation; } catch (error) { owned.error = error; throw error; }
  }
}
