import { parseThreadCatalogChange, threadCatalogStatus } from "@opencraft/appserver-protocol";
import type { ThreadStatus } from "@opencraft/appserver-protocol/generated/v2";

type Value = Record<string, any>;
type Fact = { status: ThreadStatus; revision: number; live: boolean };

/** Volatile projection of execution-owner facts, never reconstructed from history
 * or Turn/Item activity. Stored metadata cannot settle a live execution. */
export class ConversationExecutionStatus {
  private revision = 0;
  private epoch = 0;
  private readonly facts = new Map<string, Fact>();
  private readonly active = new Set<string>();
  fence() { return { epoch: this.epoch, revision: this.revision }; }
  private put(threadId: unknown, value: unknown, live: boolean): string[] {
    const status = threadCatalogStatus(value);
    if (typeof threadId !== "string" || !threadId || !status) return [];
    const old = this.facts.get(threadId);
    // Equal live observations still fence an older pending snapshot.
    this.facts.set(threadId, { status, revision: ++this.revision, live });
    if (status.type === "active") this.active.add(threadId); else this.active.delete(threadId);
    return JSON.stringify(old?.status) === JSON.stringify(status) ? [] : [threadId];
  }
  observe(method: string, params: Value): string[] {
    if (method === "thread/status/changed") return this.put(params.threadId, params.status, true);
    if (method === "opencraft/thread-catalog/changed") {
      const event = parseThreadCatalogChange(params), change = event?.change;
      if (change?.type === "patch" && change.status) return this.put(change.threadId, change.status, true);
      // Creation metadata is discovery, not a newer execution-status fact.
    }
    if (method === "thread/deleted") return this.put(params.threadId, { type: "notLoaded" }, true);
    if (method === "opencraft/codex/generation/lost" && Array.isArray(params.threadIds)) {
      return params.threadIds.flatMap((id: unknown) => this.put(id, { type: "notLoaded" }, true));
    }
    return [];
  }
  snapshot(method: string, result: Value, fence: ReturnType<ConversationExecutionStatus["fence"]>): string[] {
    // History read/resume replies are not execution observations. Only the
    // execution adapter's directory snapshot can seed an unobserved status.
    if (method !== "thread/list" || fence.epoch !== this.epoch || !Array.isArray(result.data)) return [];
    return result.data.flatMap((row: Value) => {
      if (!row || typeof row !== "object") return [];
      const old = this.facts.get(row.id);
      // Directory caches may lag even when their RPC started after a live fact.
      if (old?.live || old && old.revision > fence.revision) return [];
      return this.put(row.id, row.status, false);
    });
  }
  project(method: string, result: Value): Value {
    const row = (value: Value) => ({ ...value, status: this.facts.get(value.id)?.status ?? { type: "notLoaded" } });
    if (method === "thread/list" && Array.isArray(result.data)) return { ...result, data: result.data.map(row) };
    if (method === "thread/read" && result.thread) return { ...result, thread: row(result.thread) };
    return result;
  }
  status(threadId: string): ThreadStatus { return this.facts.get(threadId)?.status ?? { type: "notLoaded" }; }
  activeThreadIds(admitted: (id: string) => boolean = () => true): string[] {
    const ids: string[] = [];
    for (const id of this.active) { if (admitted(id)) ids.push(id); if (ids.length > 128) break; }
    return ids;
  }
  clear(): string[] {
    const ids = [...this.facts.keys()];
    this.facts.clear(); this.active.clear(); ++this.epoch; ++this.revision;
    return ids;
  }
}
