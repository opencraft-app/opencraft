import { TASKS, type TaskEvent, type TasksRequestPort } from "@opencraft/appserver-protocol";
export interface TaskActivityState {
  readonly events: readonly TaskEvent[];
  readonly nextBeforeSeq: number | null;
  readonly loading: boolean;
  readonly pending: boolean;
  readonly error: "read" | "write" | "unknown" | "conflict" | null;
}
/** Detail-scoped projection. Progress IDs live until the exact result is reconciled. */
export class TaskActivityController {
  private state: TaskActivityState = { events: [], nextBeforeSeq: null, loading: false, pending: false, error: null };
  private listeners = new Set<() => void>();
  private closed = false;
  private generation = 0;
  private queuedRefresh = false;
  private readHead: number | null = null;
  private write: { eventId: string; text: string } | null = null;
  constructor(private readonly port: TasksRequestPort, readonly taskId: string, private readonly changed: () => void = () => {}) {}
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getSnapshot = () => this.state;
  private publish(change: Partial<TaskActivityState>) {
    if (this.closed) return;
    this.state = { ...this.state, ...change }; for (const fn of this.listeners) fn();
  }
  private merge(events: readonly TaskEvent[]) {
    return [...new Map([...this.state.events, ...events].map(event => [event.eventId, event])).values()].sort((a, b) => b.seq - a.seq);
  }
  async refresh(older = false) {
    if (this.closed) return;
    if (this.state.loading) { if (!older) this.queuedRefresh = true; return; }
    const generation = ++this.generation;
    const cursor = older ? this.state.nextBeforeSeq : null;
    if (older && cursor === null) return;
    this.publish({ loading: true });
    try {
      const page = await this.port.request(TASKS.events, { taskId: this.taskId, limit: 20, ...(cursor === null ? {} : { beforeSeq: cursor }) });
      if (this.closed || generation !== this.generation) return;
      const events = this.merge(page.events);
      // A head refresh can reveal an unseen middle page. Its cursor takes
      // precedence; deduplication makes later overlap with retained rows safe.
      // Locally accepted reports can jump ahead of the last complete page.
      // Only a fetched head proves continuity with the retained older cursor.
      const known = this.readHead;
      const gap = known !== null && page.events.length > 0 && page.events.at(-1)!.seq > known;
      this.publish({ events, nextBeforeSeq: older || known === null || gap ? page.nextBeforeSeq : this.state.nextBeforeSeq, error: this.state.error === "read" ? null : this.state.error });
      if (!older) this.readHead = page.events[0]?.seq ?? null;
    } catch { this.publish({ error: this.state.error && this.state.error !== "read" ? this.state.error : "read" }); }
    finally { if (!this.closed && generation === this.generation) { this.publish({ loading: false }); if (this.queuedRefresh) { this.queuedRefresh = false; await this.refresh(); } } }
  }
  async append(text: string): Promise<boolean> {
    if (this.closed || this.state.pending || !text.trim()) return false;
    if (this.write && this.write.text !== text.trim()) { this.publish({ error: "unknown" }); return false; }
    const retained = this.write;
    const write = this.write ??= { eventId: crypto.randomUUID(), text: text.trim() };
    this.publish({ pending: true, error: null });
    const accept = (event: TaskEvent | null) => {
      if (!event || event.taskId !== this.taskId || event.type !== "progress" || event.payload.text !== write.text) return false;
      this.publish({ events: this.merge([event]), error: null }); this.write = null; this.changed(); return true;
    };
    try {
      if (retained) {
        const previous = await this.port.request(TASKS.event, { taskId: this.taskId, eventId: write.eventId });
        if (this.closed) return false;
        if (previous) { if (accept(previous)) return true; this.publish({ error: "conflict" }); return false; }
      }
      try {
        const event = await this.port.request(TASKS.progress, { taskId: this.taskId, ...write });
        if (this.closed) return false;
        if (accept(event)) return true;
        this.publish({ error: "conflict" }); return false;
      } catch {
        // The event may be older than the first page by now: read by exact ID.
        const event = await this.port.request(TASKS.event, { taskId: this.taskId, eventId: write.eventId });
        if (this.closed) return false;
        if (accept(event)) return true;
        this.publish({ error: event ? "conflict" : "write" }); return false;
      }
    } catch { this.publish({ error: "unknown" }); return false; }
    finally { this.publish({ pending: false }); }
  }
  dispose() { this.closed = true; ++this.generation; this.listeners.clear(); }
}
