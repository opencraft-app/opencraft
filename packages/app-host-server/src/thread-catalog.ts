import { randomUUID } from "node:crypto";
import { THREAD_CATALOG_CHANGED, threadCatalogEntry, threadCatalogStatus, type ThreadCatalogChange, type ThreadCatalogMutation } from "@opencraft/appserver-protocol";
import type { Thread } from "@opencraft/appserver-protocol/generated/v2";

type Value = Record<string, unknown>;
const object = (value: unknown): Value => value && typeof value === "object" && !Array.isArray(value) ? value as Value : {};

/** Server-owned directory facts. A Thread subscription is never a catalog subscription. */
export class ThreadCatalogPublisher {
  private readonly source = randomUUID();
  private revision = 0;
  private readonly allocations = new Map<string, Thread>();
  private readonly temporary = new Set<string>();
  constructor(private readonly notify: (method: string, params: ThreadCatalogChange) => void,
    private readonly firstTurnDurable = false) {}

  private publish(change: ThreadCatalogMutation): void {
    const event: ThreadCatalogChange = { version: 1, source: this.source, revision: ++this.revision, change };
    // Directory observers cannot turn a committed native mutation into a failed RPC.
    try { this.notify(THREAD_CATALOG_CHANGED, event); } catch { /* Reconnect reconciles the directory snapshot. */ }
  }
  observeResult(method: string, params: unknown, result: unknown): void {
    const input = object(params), output = object(result), raw = object(output.thread);
    if (method === "thread/unsubscribe" && typeof input.threadId === "string") { this.temporary.delete(input.threadId); }
    if (method === "thread/start" || method === "thread/fork") {
      const key = typeof raw.id === "string" ? raw.id : "";
      if (!key) return;
      if (raw.ephemeral === true || input.ephemeral === true || input.threadSource === "thread_title") { this.temporary.add(key); return; }
      const row = threadCatalogEntry({ ...raw, cwd: raw.cwd ?? output.cwd ?? input.cwd });
      if (!row) { this.publish({ type: "invalidate" }); return; }
      if (method === "thread/start" && this.firstTurnDurable) this.allocations.set(key, row);
      else this.publish({ type: "upsert", thread: row });
    } else if (method === "turn/start" && object(output.turn).id) this.commit(input.threadId);
    else if (["thread/name/set", "thread/archive", "thread/unarchive", "thread/delete"].includes(method)) {
      if (method === "thread/unarchive" && threadCatalogEntry(raw)) this.publish({ type: "upsert", thread: threadCatalogEntry(raw)! });
      else this.observeNotification(method === "thread/name/set" ? "thread/name/updated" : method === "thread/unarchive" ? "thread/unarchived" : method === "thread/archive" ? "thread/archived" : "thread/deleted", input);
    }
  }
  private commit(threadId: unknown): void {
    if (typeof threadId !== "string") return;
    const thread = this.allocations.get(threadId);
    if (!thread) return;
    this.allocations.delete(threadId);
    this.publish({ type: "upsert", thread: { ...thread, status: { type: "active", activeFlags: [] } } });
  }
  observeNotification(method: string, params: unknown): void {
    const input = object(params), raw = object(input.thread), key = input.threadId ?? raw.id;
    if (typeof key !== "string" || !key) return;
    if (method === "thread/closed") { this.allocations.delete(key); this.temporary.delete(key); return; }
    if (this.temporary.has(key) || raw.ephemeral === true) return;
    if (method === "thread/started") {
      const row = threadCatalogEntry(raw);
      if (!row) return;
      if (this.firstTurnDurable) { if (this.allocations.has(key)) this.allocations.set(key, row); }
      else this.publish({ type: "upsert", thread: row });
    } else if (method === "turn/started") this.commit(key);
    else if (method === "thread/archived" || method === "thread/deleted") {
      this.allocations.delete(key); this.publish({ type: "remove", threadId: key });
    } else if (method === "thread/unarchived") this.publish({ type: "invalidate" });
    else if (method === "thread/name/updated" && typeof (input.threadName ?? input.name) === "string") {
      const name = String(input.threadName ?? input.name);
      const allocation = this.allocations.get(key);
      if (allocation) this.allocations.set(key, { ...allocation, name });
      else this.publish({ type: "patch", threadId: key, name });
    } else if (method === "thread/status/changed") {
      const status = threadCatalogStatus(input.status);
      if (status && !this.allocations.has(key)) this.publish({ type: "patch", threadId: key, status });
    }
  }
  clear(): void { this.allocations.clear(); this.temporary.clear(); }
}
