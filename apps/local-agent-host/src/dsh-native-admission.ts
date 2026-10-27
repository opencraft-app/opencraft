import type { DshEvent } from "./dsh-client.js";
import { DshExecutionAuthority, type DshAdmission, type DshExecutionOwner } from "./dsh-execution-authority.js";
import { randomUUID } from "node:crypto";

interface Pending {
  admission: DshAdmission;
  rpcId: string;
  resolve: (turn: number) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  clientMessageId?: string;
}
/** Native turn/start has no caller token; source.rpcId on user/message does.
 * Until that proof arrives, retain the ordered prefix and expose no admission.
 */
export class DshNativeAdmission {
  private pending = new Map<string, Pending>();
  private prefixes = new Map<string, { turn: number; events: DshEvent[] }>();
  private active = new Map<string, { turn: number; admission: DshAdmission }>();
  private managed = new Set<string>();
  private readonly backgroundOwners = new Map<string, { threadId: string; owner: DshExecutionOwner; requestId: string | number }>();
  private readonly backgroundProofs = new Map<string, { threadId: string; owner: DshExecutionOwner; requestId: string | number }>();
  private goals = new Map<string, { owner: DshExecutionOwner; requestId: string | number; id?: string; revision?: number; round: number }>();
  private queued = new Map<string, { threadId: string; owner: DshExecutionOwner; requestId: string | number; clientMessageId: string }>();
  constructor(readonly authority: DshExecutionAuthority, private readonly timeoutMs = 10_000) {
    for (const entry of authority.queuedInputs()) { this.queued.set(entry.rpcId, entry); this.managed.add(entry.threadId); }
  }

  begin(threadId: string, owner: DshExecutionOwner, requestId: string | number, clientMessageId?: string) {
    const admission = this.authority.claim(threadId, owner, requestId);
    this.managed.add(threadId);
    const rpcId = "opencraft-execution-" + admission.executionId;
    try { this.authority.rememberInput(admission, rpcId, clientMessageId); }
    catch (error) { this.authority.finish(admission, "failed", "inputIdentityPersistenceFailed"); throw error; }
    this.backgroundOwners.set(rpcId, { threadId, owner, requestId });
    let reject!: (error: Error) => void;
    const started = new Promise<number>((resolve, fail) => {
      reject = fail;
      const timer = setTimeout(() => this.cancel(threadId, admission.epoch, new Error("Native turn admission timed out")), this.timeoutMs);
      this.pending.set(threadId, { admission, rpcId, resolve, reject, timer, clientMessageId });
    });
    // Dispatch can fail before the caller awaits native start; avoid an
    // unhandled rejection while preserving the caller-facing rejected promise.
    void started.catch(() => {});
    return { admission, rpcId, started, cancel: (error: Error) => this.cancel(threadId, admission.epoch, error) };
  }
  authorizeBackground(threadId: string, messageId: string, originRpcId: string) {
    const origin = this.backgroundOwners.get(originRpcId);
    if (!origin || origin.threadId !== threadId) return;
    this.backgroundProofs.set(threadId + ":" + messageId, origin);
  }
  manages(threadId: string) { return this.managed.has(threadId); }
  authorizeGoal(threadId: string, owner: DshExecutionOwner, requestId: string | number) {
    const previous = this.goals.get(threadId);
    this.goals.set(threadId, { owner, requestId, id: previous?.id, revision: previous?.revision, round: previous?.round ?? 0 });
    this.managed.add(threadId);
  }
  reserveQueued(threadId: string, owner: DshExecutionOwner, requestId: string | number, clientMessageId: string): string {
    const rpcId = "opencraft-queue-" + randomUUID();
    this.authority.queueInput(rpcId, threadId, owner, requestId, clientMessageId);
    this.managed.add(threadId);
    this.queued.set(rpcId, { threadId, owner, requestId, clientMessageId });
    this.backgroundOwners.set(rpcId, { threadId, owner, requestId });
    return rpcId;
  }
  queuedClientId(threadId: string, rpcId: string): string {
    const entry = this.queued.get(rpcId);
    return entry?.threadId === threadId ? entry.clientMessageId : rpcId;
  }
  removeQueued(rpcId: string) { this.queued.delete(rpcId); this.authority.consumeQueueInput(rpcId); }
  removeQueuedMessage(threadId: string, clientMessageId: string) {
    for (const [rpcId, entry] of this.queued) if (entry.threadId === threadId && entry.clientMessageId === clientMessageId) this.removeQueued(rpcId);
  }
  reconnect(threadId: string, owner: DshExecutionOwner) {
    const reclaimed = this.authority.reconnect(threadId, owner);
    const goal = this.goals.get(threadId);
    if (goal?.owner.identity.id === owner.identity.id && (reclaimed || !this.authority.table.get(threadId))) goal.owner = owner;
    for (const entry of this.queued.values()) if (entry.threadId === threadId && entry.owner.identity.id === owner.identity.id &&
      (reclaimed || !this.authority.table.get(threadId))) entry.owner = owner;
  }
  private cancel(threadId: string, epoch: number, error: Error) {
    const pending = this.pending.get(threadId);
    if (!pending || pending.admission.epoch !== epoch) return;
    clearTimeout(pending.timer);
    this.pending.delete(threadId);
    this.prefixes.delete(threadId);
    this.authority.finish(pending.admission, "failed", error.message);
    pending.reject(error);
  }
  accept(threadId: string, event: DshEvent): DshEvent[] {
    const data = (event.data ?? {}) as Record<string, any>;
    const running = this.active.get(threadId);
    // Goal changes are session-scoped, including edits while no Turn exists.
    // A tool-created Goal inherits its admitted human execution; cold history
    // never enters this live path and therefore cannot grant continuation.
    if (event.type === "goal/change") {
      let grant = this.goals.get(threadId);
      if (data.operation === "clear" || data.goal?.phase !== "active") this.goals.delete(threadId);
      else {
        if (!grant && running) {
          this.authorizeGoal(threadId, running.admission.connection, running.admission.requestId);
          grant = this.goals.get(threadId);
        }
        if (grant) {
          if (grant.id !== data.goal.id) grant.round = 0;
          grant.id = data.goal.id; grant.revision = data.goal.revision;
        }
      }
      return [event];
    }
    if (running) {
      if (event.type === "user/message") this.backgroundProofs.delete(threadId + ":" + data.id);
      if (typeof data.turn === "number" && data.turn !== running.turn) return [];
      if (this.authority.table.get(threadId)?.epoch !== running.admission.epoch) return [];
      if (event.type === "user/message" && this.queued.get(data.source?.rpcId)?.threadId === threadId) this.removeQueued(data.source.rpcId);
      return [this.authority.projectInput(threadId, event)];
    }
    if (event.type === "turn/start") {
      if (!Number.isSafeInteger(data.turn)) return [];
      this.prefixes.set(threadId, { turn: data.turn, events: [event] });
      return [];
    }
    const prefix = this.prefixes.get(threadId);
    if (!prefix) return [];
    prefix.events.push(event);
    if (prefix.events.length > 256 || event.type === "turn/end") {
      this.prefixes.delete(threadId);
      return [];
    }
    let pending = this.pending.get(threadId);
    let goalContinuation = false;
    let backgroundContinuation = false;
    if (event.type !== "user/message") return [];
    if (!pending && data.source?.kind === "goal") {
      const grant = this.goals.get(threadId);
      const source = data.source;
      if (!grant || source.goalId !== grant.id || source.revision !== grant.revision
        || !Number.isSafeInteger(source.round) || source.round <= grant.round) return [];
      const admission = this.authority.claimGoalContinuation(threadId, grant.owner, grant.requestId);
      goalContinuation = true;
      grant.round = source.round;
      pending = { admission, rpcId: "", resolve: () => {}, reject: () => {}, timer: setTimeout(() => {}, 0) };
    }
    if (data.source?.kind === "plugin") {
      const key = threadId + ":" + data.id, grant = this.backgroundProofs.get(key);
      this.backgroundProofs.delete(key);
      if (pending || !grant || data.source.plugin !== "tool-jobs" || data.source.form !== "notice") return [];
      const admission = this.authority.claimContinuation(threadId, grant.owner, grant.requestId);
      backgroundContinuation = true;
      pending = { admission, rpcId: "", resolve: () => {}, reject: () => {}, timer: setTimeout(() => {}, 0) };
    } else if (!["user", "human", "goal"].includes(data.source?.kind)) return [];
    if (!pending) {
      const queued = this.queued.get(data.source.rpcId);
      if (queued?.threadId === threadId) {
        const admission = this.authority.claim(threadId, queued.owner, queued.requestId);
        this.authority.rememberInput(admission, data.source.rpcId, queued.clientMessageId);
        this.backgroundOwners.set(data.source.rpcId, { threadId, owner: queued.owner, requestId: queued.requestId });
        pending = { admission, rpcId: data.source.rpcId, resolve: () => {}, reject: () => {},
          timer: setTimeout(() => {}, 0), clientMessageId: queued.clientMessageId };
        this.removeQueued(data.source.rpcId);
      }
    }
    if (!pending || (!goalContinuation && !backgroundContinuation && data.source.rpcId !== pending.rpcId)) {
      this.prefixes.delete(threadId);
      return [];
    }
    const id = `dsh-turn-${threadId}-${prefix.turn}`;
    if (!this.authority.nativeStarted(pending.admission, id, String(prefix.turn))) return [];
    clearTimeout(pending.timer);
    this.pending.delete(threadId);
    this.prefixes.delete(threadId);
    this.active.set(threadId, { turn: prefix.turn, admission: pending.admission });
    pending.resolve(prefix.turn);
    return prefix.events.map(value => this.authority.projectInput(threadId, value));
  }
  finish(threadId: string, state: "completed" | "failed" | "interrupted", reason: string) {
    const active = this.active.get(threadId);
    if (!active) return;
    this.authority.finish(active.admission, state, reason);
    this.active.delete(threadId);
  }
  failAll(error: Error) {
    this.goals.clear();
    this.backgroundOwners.clear(); this.backgroundProofs.clear();
    for (const [id, pending] of [...this.pending]) this.cancel(id, pending.admission.epoch, error);
    for (const id of [...this.active.keys()]) this.finish(id, "failed", error.message);
    this.prefixes.clear();
  }
}
