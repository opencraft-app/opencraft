import {
  TASKS,
  type TaskDetail,
  type TasksMutation,
  type TasksMethodMap,
  type TasksRequestPort,
} from "@opencraft/appserver-protocol";
export interface TasksViewState {
  readonly tasks: readonly TaskDetail[];
  readonly phase: "loading" | "ready" | "unavailable";
  readonly error: "refresh" | "conflict" | "save" | null;
  readonly pending: boolean;
}
/** One backend owns the records. This controller only holds a display projection. */
export class TasksController {
  private state: TasksViewState = {
    tasks: [],
    phase: "loading",
    error: null,
    pending: false,
  };
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private closed = false;
  private supported = false;
  private queuedRefresh = false;
  constructor(private readonly port: TasksRequestPort) {}
  getSnapshot = (): TasksViewState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  async start(): Promise<void> {
    if (this.supported) return this.refresh();
    try {
      const capability = await this.port.request(TASKS.capabilities, {});
      if (this.closed) return;
      if (capability.version !== 1 || capability.storage !== "sqlite-rows")
        throw new Error("Unsupported Tasks storage");
      this.supported = true;
      await this.refresh();
    } catch {
      this.publish({ phase: "unavailable" });
    }
  }
  async refresh(): Promise<void> {
    if (this.closed || !this.supported) return;
    if (this.state.pending) {
      this.queuedRefresh = true;
      return;
    }
    const generation = ++this.generation;
    try {
      const { tasks } = await this.port.request(TASKS.list, {});
      if (!this.closed && generation === this.generation)
        this.publish({ tasks, phase: "ready", error: null });
    } catch {
      if (!this.closed && generation === this.generation)
        this.publish({ phase: "ready", error: "refresh" });
    }
  }
  async mutate<M extends TasksMutation>(
    method: M,
    params: TasksMethodMap[M]["params"],
  ): Promise<boolean> {
    if (this.closed || !this.supported || this.state.pending) return false;
    ++this.generation;
    this.publish({ pending: true, error: null });
    let saved = false;
    let error: TasksViewState["error"] = null;
    try {
      const { tasks } = await this.port.request(method, params);
      if (!this.closed) {
        this.publish({ tasks, phase: "ready" });
        saved = true;
      }
    } catch (cause) {
      error =
        (cause as { code?: unknown } | null)?.code === -32051
          ? "conflict"
          : "save";
    } finally {
      this.publish({ pending: false });
      if (!this.closed && (error || this.queuedRefresh)) {
        this.queuedRefresh = false;
        // A lost acknowledgement can follow a commit: read, never replay blindly.
        await this.refresh();
      }
      if (error) this.publish({ error });
    }
    return saved;
  }
  dispose(): void {
    this.closed = true;
    ++this.generation;
    this.listeners.clear();
  }
  private publish(change: Partial<TasksViewState>): void {
    if (this.closed) return;
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }
}
