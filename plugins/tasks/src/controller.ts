import {
  TASKS,
  type TaskDetail,
  type TaskMember,
  type TasksMutation,
  type TasksMethodMap,
  type TasksRequestPort,
} from "@opencraft/appserver-protocol";
export interface TasksViewState {
  readonly tasks: readonly TaskDetail[];
  readonly members: readonly TaskMember[];
  readonly properties: boolean;
  readonly planning: boolean;
  readonly aiResearch: boolean;
  readonly supportedKinds: readonly string[];
  readonly activity: boolean;
  readonly progress: boolean;
  readonly memberIdentity: boolean;
  readonly archive: boolean;
  readonly recycled: readonly TaskDetail[];
  readonly recycleBinRetentionMs: number | null;
  readonly phase: "loading" | "ready" | "error" | "unavailable";
  readonly error: "refresh" | "conflict" | "save" | "restore" | null;
  readonly pending: boolean;
}
/** One backend owns the records. This controller only holds a display projection. */
export class TasksController {
  private state: TasksViewState = {
    tasks: [],
    members: [],
    properties: false,
    aiResearch: false,
    planning: false, supportedKinds: [], activity: false, progress: false,
    memberIdentity: false,
    archive: false,
    recycled: [],
    recycleBinRetentionMs: null,
    phase: "loading",
    error: null,
    pending: false,
  };
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private capabilityGeneration = 0;
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
    if (this.state.phase !== "ready") this.publish({ phase: "loading", error: null });
    const generation = ++this.capabilityGeneration;
    try {
      const capability = await this.port.request(TASKS.capabilities, {});
      if (this.closed || generation !== this.capabilityGeneration) return;
      if (capability.version !== 1 || capability.storage !== "sqlite-rows")
        throw new Error("Unsupported Tasks storage");
      this.supported = true;
      this.publish({ aiResearch: capability.aiResearch === true, properties: capability.properties === true, memberIdentity: capability.memberIdentity === true, planning: capability.planning === true, supportedKinds: capability.supportedKinds ?? [], activity: capability.activity === true, progress: capability.progress === true });
      this.publish({ recycleBinRetentionMs: capability.recycleBinRetentionMs ?? null, archive: capability.archive === true });
      await this.refresh();
    } catch {
      if (!this.closed && generation === this.capabilityGeneration) this.publish(this.state.phase === "ready" ? { error: "refresh" } : { phase: this.supported ? "error" : "unavailable", error: null });
    }
  }
  async refresh(): Promise<void> {
    if (this.closed || !this.supported) return;
    if (this.state.pending) {
      this.queuedRefresh = true;
      return;
    }
    if (this.state.phase !== "ready") this.publish({ phase: "loading", error: null });
    const generation = ++this.generation;
    try {
      const { tasks, members, recycled = [] } = await this.port.request(TASKS.list, {});
      if (!this.closed && generation === this.generation)
        this.publish({ tasks, recycled, members: members ?? [], phase: "ready", error: null });
    } catch {
      if (!this.closed && generation === this.generation)
        this.publish(this.state.phase === "ready" ? { error: "refresh" } : { phase: "error", error: null });
    }
  }
  async mutate<M extends TasksMutation>(
    method: M,
    params: TasksMethodMap[M]["params"],
  ): Promise<boolean> {
    if (this.closed || !this.supported || this.state.pending) return false;
    if ((method === TASKS.archive || method === TASKS.unarchive) && !this.state.archive) return false;
    ++this.generation;
    this.publish({ pending: true, error: null });
    let saved = false;
    let error: TasksViewState["error"] = null;
    try {
      const { tasks, members, recycled = [] } = await this.port.request(method, params);
      if (!this.closed) {
        this.publish({ tasks, recycled, members: members ?? [], phase: "ready" });
        saved = true;
      }
    } catch (cause) {
      error =
        (cause as { code?: unknown } | null)?.code === -32051
          ? "conflict"
          : method === TASKS.restore ? "restore" : "save";
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
