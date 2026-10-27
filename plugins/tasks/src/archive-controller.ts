import { TASKS, type TaskArchivePage, type TasksRequestPort } from "@opencraft/appserver-protocol";
export interface TasksArchiveState extends TaskArchivePage {
  readonly query: string;
  readonly loading: boolean;
  readonly error: boolean;
}
/** One bounded query projection; old searches cannot overwrite newer results. */
export class TasksArchiveController {
  private state: TasksArchiveState = { tasks: [], nextCursor: null, query: "", loading: false, error: false };
  private generation = 0;
  private closed = false;
  private listeners = new Set<() => void>();
  constructor(private readonly port: TasksRequestPort) {}
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private publish(change: Partial<TasksArchiveState>) {
    if (this.closed) return;
    this.state = { ...this.state, ...change }; for (const fn of this.listeners) fn();
  }
  search(query: string) {
    const changed = query !== this.state.query;
    this.publish({ query, ...(changed ? { tasks: [], nextCursor: null } : {}) });
    return this.refresh();
  }
  async refresh(older = false) {
    if (this.closed || (older && (this.state.loading || !this.state.nextCursor))) return;
    const generation = ++this.generation, before = older ? this.state.nextCursor : null;
    this.publish({ loading: true, error: false });
    try {
      const page = await this.port.request(TASKS.archives, { search: this.state.query, limit: 50, ...(before ? { before } : {}) });
      if (this.closed || generation !== this.generation) return;
      this.publish({ tasks: older ? [...new Map([...this.state.tasks, ...page.tasks].map(task => [task.id, task])).values()] : page.tasks, nextCursor: page.nextCursor });
    } catch {
      if (!this.closed && generation === this.generation) this.publish({ error: true });
    } finally {
      if (!this.closed && generation === this.generation) this.publish({ loading: false });
    }
  }
  dispose() { this.closed = true; ++this.generation; this.listeners.clear(); }
}
