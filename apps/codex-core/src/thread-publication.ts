type Row = Record<string, unknown>;
const row = (v: unknown): Row => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});
/** Native allocation precedes Hub ownership commit. The native process lifetime
 * owns this publication barrier; it stores no Human identity or permission. */
export class ThreadPublication {
  private readonly allocations = new Map<string, { owner: object; threadId?: string }>();
  private readonly known = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private unresolved = 0;
  private knownBytes = 0;
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  hasOwner(owner: object): boolean {
    return [...this.allocations.values()].some((value) => value.owner === owner);
  }
  begin(operation: string, owner: object) {
    const prior = this.allocations.get(operation);
    if (prior) {
      if (prior.owner !== owner) throw Error("Creation publication belongs to another lane");
      return;
    }
    if (this.allocations.size >= 1024) throw Error("Pending publication limit");
    this.allocations.set(operation, { owner });
    this.unresolved++;
  }
  resolve(operation: string, owner: object, threadId?: string) {
    const pending = this.allocations.get(operation);
    if (!pending || pending.owner !== owner) throw Error("Unknown creation publication");
    if (!pending.threadId) this.unresolved--;
    if (threadId) pending.threadId = threadId;
    else this.allocations.delete(operation);
    this.changed();
  }
  publish(operation: string, owner: object) {
    const pending = this.allocations.get(operation);
    if (!pending) return true;
    if (pending.owner !== owner || !pending.threadId) return false;
    this.remember(pending.threadId);
    this.allocations.delete(operation);
    this.changed();
    return true;
  }
  private changed() {
    for (const listener of this.listeners) listener();
  }
  private remember(id: string) {
    if (this.known.has(id)) return;
    const bytes = Buffer.byteLength(id);
    if (this.known.size < 100000 && this.knownBytes + bytes <= 8 * 1024 * 1024) {
      this.known.add(id);
      this.knownBytes += bytes;
    }
  }
  allowed(id: string) {
    for (const value of this.allocations.values()) if (value.threadId === id) return false;
    return !this.unresolved || this.known.has(id);
  }
  observed(id: string) {
    if (this.allowed(id)) this.remember(id);
  }
  created(id: string) {
    this.remember(id);
    this.changed();
  }
  references(value: unknown): string[] {
    const v = row(value),
      ids: string[] = [];
    for (const key of ["threadId", "thread_id"]) if (typeof v[key] === "string") ids.push(v[key] as string);
    if (typeof row(v.thread).id === "string") ids.push(row(v.thread).id as string);
    if (Array.isArray(v.threadIds)) ids.push(...v.threadIds.filter((id): id is string => typeof id === "string"));
    return ids;
  }
  project(method: string | undefined, value: unknown): unknown {
    const result = row(value);
    if (
      method &&
      ["thread/list", "thread/search", "thread/loaded/list", "opencraft/thread-pins/list"].includes(method)
    ) {
      const out = { ...result };
      for (const key of ["data", "threads", "threadIds", "results", "matches"])
        if (Array.isArray(out[key]))
          out[key] = (out[key] as unknown[]).filter((v) => {
            const id = typeof v === "string" ? v : (row(v).threadId ?? row(v).id ?? row(row(v).thread).id);
            if (typeof id !== "string" || !this.allowed(id)) return false;
            this.remember(id);
            return true;
          });
      for (const key of ["total", "totalCount", "count"]) delete out[key];
      return out;
    }
    return value;
  }
}
