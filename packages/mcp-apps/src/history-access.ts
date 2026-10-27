import { appEnvelope, MCP_APPS_NAMESPACE } from "@opencraft/appserver-protocol/mcp-apps";

export interface AppReference { server: string; resourceUri: string }
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Accept only completed builder output in engine-owned items, never user text or arguments. */
function reference(value: unknown): AppReference | null {
  const item = record(value);
  if (item.type !== "dynamicToolCall" || item.status !== "completed" || item.success !== true
    || !((item.namespace === MCP_APPS_NAMESPACE && item.tool === "manage")
      || (item.namespace === "deepseek-harness" && item.tool === `${MCP_APPS_NAMESPACE}__manage`))) return null;
  if (!Array.isArray(item.contentItems)) return null;
  for (const block of item.contentItems) {
    const b = record(block);
    if (b.type !== "inputText" || typeof b.text !== "string" || b.text.length > 262144) continue;
    try {
      const app = appEnvelope(JSON.parse(b.text));
      if (app && app.resourceUri.startsWith("ui://opencraft/apps/"))
        return { server: app.server, resourceUri: app.resourceUri };
    } catch { /* Other tool output cannot authorize a release. */ }
  }
  return null;
}

/** Ephemeral connection evidence. History remains owned by the execution engine. */
export class AppHistoryAccess {
  private requests = new Map<string | number, { threadId: string; method: string }>();
  private threads = new Map<string, Map<string, AppReference>>();
  clear() { this.requests.clear(); this.threads.clear(); }
  requested(id: string | number, method: unknown, params: Record<string, unknown>) {
    if (!["thread/read", "thread/resume", "thread/rollback", "thread/turns/list", "thread/items/list"].includes(String(method))
      || typeof params.threadId !== "string" || this.requests.size >= 128) return;
    this.requests.set(id, { threadId: params.threadId, method: String(method) });
  }
  references(threadId: unknown): AppReference[] {
    return typeof threadId === "string" ? [...(this.threads.get(threadId)?.values() ?? [])] : [];
  }
  private add(threadId: string, item: unknown) {
    const app = reference(item);
    if (!app) return;
    let refs = this.threads.get(threadId);
    if (!refs) {
      if (this.threads.size >= 64) this.threads.delete(this.threads.keys().next().value!);
      this.threads.set(threadId, refs = new Map());
    }
    if (refs.size < 256) refs.set(JSON.stringify([app.server, app.resourceUri]), app);
  }
  private turns(threadId: string, value: unknown) {
    if (!Array.isArray(value)) return;
    for (const turn of value) {
      const items = record(turn).items;
      if (Array.isArray(items)) for (const item of items) this.add(threadId, item);
    }
  }
  observed(frame: Record<string, unknown>) {
    const p = record(frame.params);
    if (["thread/deleted", "thread/closed"].includes(String(frame.method)) && typeof p.threadId === "string") this.threads.delete(p.threadId);
    if (frame.method === "item/completed" && typeof p.threadId === "string") this.add(p.threadId, p.item);
    if (frame.method !== undefined) return;
    if (typeof frame.id !== "string" && typeof frame.id !== "number") return;
    const request = this.requests.get(frame.id);
    this.requests.delete(frame.id);
    if (!request || frame.error || !frame.result) return;
    const r = record(frame.result), thread = record(r.thread), id = request.threadId;
    if (request.method === "thread/read" || request.method === "thread/resume" || request.method === "thread/rollback") {
      if (thread.id !== id) return;
      if (request.method === "thread/rollback") this.threads.delete(id);
      this.turns(id, thread.turns);
      this.turns(id, record(r.initialTurnsPage).data);
    } else if (request.method === "thread/turns/list") this.turns(id, r.data);
    else if (Array.isArray(r.data)) for (const entry of r.data) this.add(id, record(entry).item);
  }
}
