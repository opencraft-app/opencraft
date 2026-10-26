import { randomUUID } from "node:crypto";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import type { DuplexTransport, TransportStatus, TransportSubmissionContext } from "@opencraft/appserver-client/transport";
import { ExecutionLeaseStore, snapshotExecutionSubmission } from "./execution-lease-store.js";
import type { NativeExecutionProcess } from "./native-execution-origin.js";

type RecordValue = Record<string, any>;
const record = (v: unknown): RecordValue => v && typeof v === "object" && !Array.isArray(v) ? v as RecordValue : {};
const text = (v: unknown): string => typeof v === "string" ? v : "";
const key = (v: RecordValue) => JSON.stringify([v[LOGICAL_CLIENT_FIELD] ?? "", typeof v.id, v.id]);
interface Pending { method: string; params: RecordValue; inputId: string; at: number; }

/** Gateway receipt tracker for independently owned engine queues. The native
 * submission identity, rather than the person clicking start, binds execution. */
export class ExecutionLeaseTracker {
  private readonly pending = new Map<string, Pending>();
  constructor(readonly store: ExecutionLeaseStore) {}
  prepare(message: RecordValue, context: TransportSubmissionContext, native?: NativeExecutionProcess | null): RecordValue {
    const method = text(message.method), params = { ...record(message.params) }, threadId = text(params.threadId);
    const reads = ["thread/read", "thread/resume"].includes(method);
    const writes = ["turn/start", "turn/steer", "thread/queue/add", "thread/queue/start"].includes(method);
    if (!reads && !writes) return message;
    for (const [id, request] of this.pending) if (Date.now() - request.at > 300_000) this.pending.delete(id);
    if (this.pending.size >= 256 || this.pending.has(key(message))) throw new Error("Too many pending execution receipts");
    if (reads) {
      this.pending.set(key(message), { method, params, inputId: "", at: Date.now() });
      return message;
    }
    if (!threadId) throw new Error("Execution Thread required");
    context.resourceOwner?.assertCurrent();
    const submission = snapshotExecutionSubmission(context);
    let inputId = text(params.clientUserMessageId);
    if (method !== "thread/queue/start") {
      inputId ||= `input:${randomUUID()}`; params.clientUserMessageId = inputId;
      this.store.capture(threadId, inputId, submission, method === "thread/queue/add" ? "pending" : "accepted", method === "turn/steer" ? "steer" : method === "thread/queue/add" ? "queue" : "start");
      if (method === "thread/queue/add") params.__opencraftExecutionAdmission = this.store.queueAdmissionToken(threadId,inputId);
    } else inputId = this.store.queuedInput(threadId, text(params.queuedSubmissionId)) ?? "";
    if ((method === "turn/start" || method === "thread/queue/start") && inputId) this.store.begin(threadId, inputId, native?.incarnation);
    this.pending.set(key(message), { method, params, inputId, at: Date.now() });
    // Identity stays in trusted context/SQLite, never in Renderer or engine params.
    delete params.executionPrincipal;
    return { ...message, params };
  }
  observe(message: RecordValue, native?: NativeExecutionProcess | null): void {
    const method = text(message.method), params = record(message.params), threadId = text(params.threadId);
    if (method) {
      if (method === "turn/started" && threadId && text(record(params.turn).id)) {
        const turn = record(params.turn);
        this.store.observedStart(threadId, text(turn.id), native?.incarnation);
        for (const item of Array.isArray(turn.items) ? turn.items : []) if (item.type === "userMessage" && item.__opencraftMessageKind !== "steering") {
          const inputId = text(item.clientId) || text(item.clientUserMessageId) || text(item.client_id);
          if (inputId) this.store.observedInput(threadId, text(turn.id), inputId);
        }
      }
      if (method === "turn/completed" && threadId) this.store.finished(threadId, text(record(params.turn).id));
      if ((method === "item/started" || method === "item/completed") && threadId) {
        const item = record(params.item);
        if (item.type === "userMessage" && item.__opencraftMessageKind !== "steering") {
          const inputId = text(item.clientId) || text(item.clientUserMessageId) || text(item.client_id);
          if (inputId) this.store.observedInput(threadId, text(params.turnId), inputId);
        }
      }
      return;
    }
    const pending = this.pending.get(key(message)); if (!pending) return;
    this.pending.delete(key(message));
    const t = text(pending.params.threadId);
    if ("error" in message) {
      if (["turn/start", "thread/queue/start"].includes(pending.method) && pending.inputId)
        this.store.outcome(t, pending.inputId, [-32600,-32601,-32602].includes(Number(record(message.error).code)));
      return;
    }
    const result = record(message.result);
    if (["thread/read", "thread/resume"].includes(pending.method)) {
      const thread = record(result.thread);
      if (Array.isArray(thread.turns)) {
        this.store.reconcile(t, thread.turns);
        for (const turn of thread.turns) for (const item of Array.isArray(turn.items) ? turn.items : []) if (item.type === "userMessage" && item.__opencraftMessageKind !== "steering") {
          const inputId = text(item.clientId) || text(item.clientUserMessageId) || text(item.client_id);
          if (inputId) this.store.observedInput(t, text(turn.id), inputId);
        }
      }
    }
    if (pending.method === "thread/queue/add") {
      const id = text(record(result.queuedSubmission).id);
      if (id) {
        this.store.confirmQueued(t, pending.inputId, record(result.queuedSubmission).__opencraftExecutionAdmission);
        this.store.bindQueue(t, id, pending.inputId);
      }
    }
    if (["turn/start", "thread/queue/start"].includes(pending.method)) {
      const turnId = text(record(result.turn).id) || text(result.turnId);
      if (turnId && pending.inputId) this.store.started(t, turnId, pending.inputId);
    }
  }
}

/** Keeps ownership outside a renderer connection. The caller owns the SQLite
 * lifetime and supplies native identity through a verified local attachment. */
export class ExecutionOwnershipTransport implements DuplexTransport {
  private readonly tracker: ExecutionLeaseTracker;
  private readonly release: () => void;
  private observations: Promise<void> = Promise.resolve();
  private readonly releaseStatus: () => void;
  constructor(private readonly inner: DuplexTransport, store: ExecutionLeaseStore,
    private readonly native: (threadId: string) => Promise<NativeExecutionProcess | null>) {
    this.tracker = new ExecutionLeaseTracker(store);
    this.releaseStatus = inner.subscribeStatus(status => { if (["failed", "closed"].includes(status.state)) store.suspend(); });
    this.release = inner.subscribeMessage(frame => {
      this.observations = this.observations.then(async () => {
        const message = record(JSON.parse(frame));
        const origin = message.method === "turn/started" ? await this.native(text(record(message.params).threadId)) : null;
        this.tracker.observe(message, origin);
      }).catch(() => { store.suspend(); });
    });
  }
  get status() { return this.inner.status; }
  connect(signal?: AbortSignal) { return this.inner.connect(signal); }
  subscribeMessage(listener: (frame: string) => void) { return this.inner.subscribeMessage(listener); }
  subscribeStatus(listener: (status: TransportStatus) => void) { return this.inner.subscribeStatus(listener); }
  subscribeRecoveryHint(listener: () => void) { return this.inner.subscribeRecoveryHint?.(listener) ?? (() => {}); }
  async close() { this.release(); this.releaseStatus(); await this.inner.close(); await this.observations; }
  send(frame: string, signal?: AbortSignal) { return this.sendWithContext(frame, { sender: null }, signal); }
  async sendWithContext(frame: string, context: TransportSubmissionContext, signal?: AbortSignal) {
    let message = record(JSON.parse(frame));
    if (["turn/start", "turn/steer", "thread/queue/add", "thread/queue/start"].includes(text(message.method))) {
      const native = await this.native(text(record(message.params).threadId));
      if (signal?.aborted) throw new Error("Execution admission cancelled");
      message = this.tracker.prepare(message, context, native);
    } else message = this.tracker.prepare(message, context);
    if (this.inner.sendWithContext) await this.inner.sendWithContext(JSON.stringify(message), context, signal);
    else await this.inner.send(JSON.stringify(message), signal);
  }
}
