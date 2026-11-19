import { randomUUID } from "node:crypto";
import { THREAD_CATALOG_CHANGED, threadCatalogEntry, threadCatalogStatus, type ThreadCatalogChange, type ThreadCatalogMutation } from "@opencraft/appserver-protocol";
import type { Thread } from "@opencraft/appserver-protocol/generated/v2";

import { MemoryThreadCreationEvidence, type ThreadCreationEvidenceStore } from "./thread-creation-evidence";
export type { ThreadCreationEvidenceStore } from "./thread-creation-evidence";

type Value = Record<string, unknown>;
const object = (value: unknown): Value => value && typeof value === "object" && !Array.isArray(value) ? value as Value : {};

/** Server-owned directory facts. A Thread subscription is never a catalog subscription. */
export class ThreadCatalogPublisher {
  private readonly source = randomUUID();
  private revision = 0;
  private memory = new MemoryThreadCreationEvidence();
  private readonly earlyAcceptance = new Map<string, { turnId: string; status: Thread["status"] }>();
  private readonly published = new Set<string>();
  private get creations(): ThreadCreationEvidenceStore { return this.creationStore?.() ?? this.memory; }
  private readonly temporary = new Set<string>();
  private readonly unindexed = new Map<string, Thread>();
  constructor(private readonly notify: (method: string, params: ThreadCatalogChange) => void,
    private readonly firstTurnDurable = false,
    private readonly creationStore?: () => ThreadCreationEvidenceStore | undefined,
    private readonly observationFailed?: () => void) {}

  private observe(operation: () => void): void {
    try { operation(); }
    catch {
      // Catalog projection is not the native mutation's acknowledgement owner.
      // A failed journal write must not invite the caller to repeat a Turn.
      this.publish({ type: "invalidate" });
      this.reportFailure();
    }
  }
  private reportFailure(): void { try { this.observationFailed?.(); } catch { /* Diagnostics are not mutation owners either. */ } }

  private publish(change: ThreadCatalogMutation): void {
    if (change.type === "upsert") this.unindexed.set(change.thread.id, change.thread);
    else if (change.type === "remove") this.unindexed.delete(change.threadId);
    else if (change.type === "patch") {
      const row = this.unindexed.get(change.threadId);
      if (row) this.unindexed.set(row.id, { ...row, ...(change.name === undefined ? {} : { name: change.name }),
        ...(change.status === undefined ? {} : { status: change.status }) });
    }
    const event: ThreadCatalogChange = { version: 1, source: this.source, revision: ++this.revision, change };
    // Directory observers cannot turn a committed native mutation into a failed RPC.
    try { this.notify(THREAD_CATALOG_CHANGED, event); } catch { /* Reconnect reconciles the directory snapshot. */ }
  }
  /** Add committed creations only to the client view of the first native or cached page. */
  projectList(params: unknown, result: unknown): unknown {
    try { return this.projectCommittedList(params, result); }
    catch { this.reportFailure(); return result; }
  }
  private projectCommittedList(params: unknown, result: unknown): unknown {
    const input = object(params), output = object(result);
    const committed = new Map([...this.creations.committed().map(row => [row.id, row] as const), ...this.unindexed]);
    if (!committed.size || !Array.isArray(output.data) || output.catalogSnapshot
      || input.cursor != null || input.archived === true || input.sortDirection === "asc"
      || (input.sortKey != null && input.sortKey !== "updated_at")
      || !Object.keys(input).every(key => ["cursor", "limit", "archived", "sortKey", "sortDirection", "useStateDbOnly"].includes(key))) return result;

    const present = new Set(output.data.map(value => object(value).id));
    const missing = [...committed.values()].filter(row => !present.has(row.id));
    if (!missing.length) return result;
    const data = [...missing, ...output.data]
      .sort((a, b) => Number(object(b).recencyAt ?? object(b).updatedAt ?? 0) - Number(object(a).recencyAt ?? object(a).updatedAt ?? 0));
    return { ...output, data };
  }

  observeResult(method: string, params: unknown, result: unknown): void {
    this.observe(() => this.recordResult(method, params, result));
  }
  private recordResult(method: string, params: unknown, result: unknown): void {
    const input = object(params), output = object(result), raw = object(output.thread);
    if (method === "thread/list" && Array.isArray(output.data)) {
      // Native persistence and its discovery index need not become visible together.
      // Retire a committed creation only when the native directory observes it.
      for (const value of output.data) { const id = object(value).id; if (typeof id === "string") { this.unindexed.delete(id); this.creations.retire(id); this.earlyAcceptance.delete(id); } }
      return;
    }
    if (method === "thread/unsubscribe" && typeof input.threadId === "string") { this.temporary.delete(input.threadId); }
    if (method === "thread/start" || method === "thread/fork") {
      const key = typeof raw.id === "string" ? raw.id : "";
      if (!key) return;
      if (raw.ephemeral === true || input.ephemeral === true || input.threadSource === "thread_title") { this.temporary.add(key); this.creations.retire(key); this.earlyAcceptance.delete(key); return; }
      const row = threadCatalogEntry({ ...raw, cwd: raw.cwd ?? output.cwd ?? input.cwd });
      if (!row) { this.publish({ type: "invalidate" }); return; }
      if (method === "thread/start" && this.firstTurnDurable) this.allocate(row);
      else this.publish({ type: "upsert", thread: row });
    } else if (method === "turn/start" && object(output.turn).id) this.commit(input.threadId, object(output.turn).id);
    else if (["thread/name/set", "thread/archive", "thread/unarchive", "thread/delete"].includes(method)) {
      if (method === "thread/unarchive" && threadCatalogEntry(raw)) this.publish({ type: "upsert", thread: threadCatalogEntry(raw)! });
      else this.observeNotification(method === "thread/name/set" ? "thread/name/updated" : method === "thread/unarchive" ? "thread/unarchived" : method === "thread/archive" ? "thread/archived" : "thread/deleted", input);
    }
  }
  private allocate(row: Thread): void {
    this.creations.allocate(row);
    const accepted = this.earlyAcceptance.get(row.id);
    if (accepted) { this.earlyAcceptance.delete(row.id); this.commit(row.id, accepted.turnId, accepted.status); }
    else if (this.creations.read(row.id)?.accepted) this.publishCreation(row.id);
  }
  private publishCreation(id: string): void {
    const evidence = this.creations.read(id);
    if (!evidence?.accepted || evidence.retired || this.published.has(id)) return;
    this.published.add(id);
    if (this.published.size > 1024) this.published.delete(this.published.values().next().value!);
    this.publish({ type: "upsert", thread: { ...evidence.thread } });
  }
  private commit(threadId: unknown, turnId: unknown, status: Thread["status"] = { type: "active", activeFlags: [] }): void {
    if (typeof threadId !== "string" || typeof turnId !== "string" || !turnId || this.temporary.has(threadId)) return;
    const evidence = this.creations.read(threadId);
    if (!evidence) {
      // A notification can precede its metadata/receipt. This is acceptance
      // evidence only: never manufacture a directory row from an ID.
      // A duplicate acceptance cannot undo a later status/completion already
      // observed for that same Turn while its metadata was still missing.
      if (this.earlyAcceptance.get(threadId)?.turnId !== turnId) this.earlyAcceptance.set(threadId, { turnId, status });
      if (this.earlyAcceptance.size > 256) this.earlyAcceptance.delete(this.earlyAcceptance.keys().next().value!);
      return;
    }
    if (evidence.retired) return;
    if (!evidence.accepted) {
      this.creations.accept(threadId, turnId);
    }
    if (!this.published.has(threadId)) this.creations.patch(threadId, { status });
    this.publishCreation(threadId);
  }
  observeNotification(method: string, params: unknown): void {
    this.observe(() => this.recordNotification(method, params));
  }
  private recordNotification(method: string, params: unknown): void {
    const input = object(params), raw = object(input.thread), key = input.threadId ?? raw.id;
    if (typeof key !== "string" || !key) return;
    if (method === "thread/closed") { this.temporary.delete(key); return; }
    if (this.temporary.has(key) || raw.ephemeral === true || raw.threadSource === "thread_title") return;
    if (method === "thread/started") {
      const row = threadCatalogEntry(raw);
      if (!row) return;
      if (this.firstTurnDurable) this.allocate(row);
      else this.publish({ type: "upsert", thread: row });
    } else if (method === "turn/started" && typeof object(input.turn).id === "string") {
      this.commit(key, object(input.turn).id);
      this.publish({ type: "patch", threadId: key, status: { type: "active", activeFlags: [] } });
    }
    else if (method === "turn/completed") {
      const pending = this.earlyAcceptance.get(key);
      if (pending && pending.turnId === object(input.turn).id) pending.status = { type: "idle" };
      this.publish({ type: "invalidate" });
    }
    else if (method === "thread/archived" || method === "thread/deleted") {
      this.creations.retire(key, true); this.earlyAcceptance.delete(key); this.publish({ type: "remove", threadId: key });
    } else if (method === "thread/unarchived") this.publish({ type: "invalidate" });
    else if (method === "thread/name/updated" && typeof (input.threadName ?? input.name) === "string") {
      const name = String(input.threadName ?? input.name);
      const allocation = this.creations.read(key);
      this.creations.patch(key, { name });
      if (!allocation || allocation.accepted) this.publish({ type: "patch", threadId: key, name });
    } else if (method === "thread/status/changed") {
      const status = threadCatalogStatus(input.status);
      const pending = this.earlyAcceptance.get(key);
      if (status && pending) pending.status = status;
      if (status) this.creations.patch(key, { status });
      if (status && (!this.creations.read(key) || this.creations.read(key)?.accepted)) this.publish({ type: "patch", threadId: key, status });
    }
  }
  clear(): void { this.memory = new MemoryThreadCreationEvidence(); this.earlyAcceptance.clear(); this.published.clear(); this.temporary.clear(); this.unindexed.clear(); }
}
