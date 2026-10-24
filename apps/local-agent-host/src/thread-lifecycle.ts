import { ThreadCatalog } from "./thread-catalog.js";
import { ThreadAttachments } from "./thread-attachments.js";
type Params = Record<string, any>;
type Delegate = (method: string, params: Params) => Promise<any>;

/** Product metadata transactions and connection-scoped attachment, never an engine history cache. */
export class ThreadLifecycle {
  readonly attachments = new ThreadAttachments();
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;
  private readonly closedTemporaryIds = new Set<string>();
  private readonly disconnectedClients = new Set<string>();
  private readonly restoringClients = new Map<string, Set<string>>();
  /** Deliver observations during Resume; Session buffers them across its baseline. */
  receivesNotifications(clientId: string, threadId: string): boolean {
    return !this.closed && !this.disconnectedClients.has(clientId)
      && (this.attachments.has(clientId, threadId) || this.restoringClients.get(clientId)?.has(threadId) === true);
  }
  constructor(readonly catalog: ThreadCatalog, private readonly release: (id: string) => Promise<{ released: boolean }>,
    private readonly notify: (method: string, params: Params) => void, private readonly graceMs = 30 * 60 * 1000) {}
  private async known(id: string, delegate: Delegate) {
    const known = this.catalog.get(id);
    if (known) return known;
    const reply = await delegate("thread/read", { threadId: id, includeTurns: false });
    return this.catalog.upsert(reply.thread);
  }
  private decorate(reply: any): any {
    if (!reply?.thread?.id) return reply;
    const thread = this.catalog.upsert(reply.thread);
    return { ...reply, thread: { ...thread, turns: reply.thread.turns ?? [],
      status: this.attachments.isLoaded(thread.id) ? reply.thread.status ?? { type: "idle" } : { type: "notLoaded" } },
      ...(reply.runtimeWorkspaceRoots ? { runtimeWorkspaceRoots: this.catalog.configuration(thread.id).runtimeWorkspaceRoots ?? reply.runtimeWorkspaceRoots } : {}) };
  }
  assertOpen(threadId: string): void {
    if (this.closedTemporaryIds.has(threadId)) throw new Error("Temporary thread has been closed");
  }
  private async execute(method: string, params: Params, clientId: string, delegate: Delegate): Promise<any> {
    if (this.closed) throw new Error("Thread lifecycle is closing");
    this.assertClient(clientId);
    if (method !== "thread/unsubscribe" && typeof params.threadId === "string") this.assertOpen(params.threadId);
    if (method === "thread/name/set") {
      await this.known(params.threadId, delegate);
      this.catalog.rename(params.threadId, params.name);
      this.notify("thread/name/updated", { threadId: params.threadId, threadName: this.catalog.get(params.threadId)!.name });
      return {};
    }
    if (method === "thread/archive" || method === "thread/unarchive") {
      await this.known(params.threadId, delegate);
      const archived = method === "thread/archive", changed = this.catalog.isArchived(params.threadId) !== archived;
      const thread = this.catalog.archive(params.threadId, archived);
      if (changed) this.notify(archived ? "thread/archived" : "thread/unarchived", { threadId: params.threadId });
      return archived ? {} : this.decorate({ thread });
    }
    if (method === "thread/list") {
      let cursor: string | null = null;
      do {
        const page = await delegate("thread/list", { cursor, limit: 1000 });
        for (const thread of page.data) this.catalog.upsert(thread);
        cursor = page.nextCursor ?? null;
      } while (cursor !== null);
      const offset = params.cursor == null ? 0 : Number(String(params.cursor).replace(/^oc:/, ""));
      const limit = params.limit ?? 100;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid thread pagination");
      let all = this.catalog.list(params.archived === true);
      if (typeof params.cwd === "string") all = all.filter(thread => thread.cwd === params.cwd);
      if (typeof params.searchTerm === "string") all = all.filter(thread => String(thread.name ?? "").toLocaleLowerCase().includes(params.searchTerm.toLocaleLowerCase()));
      if (typeof params.parentThreadId === "string") all = all.filter(thread => thread.parentThreadId === params.parentThreadId);
      all.sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0) || a.id.localeCompare(b.id));
      if (params.sortDirection === "asc") all.reverse();
      const data = all.slice(offset, offset + limit).map(thread => ({ ...thread, status: this.attachments.isLoaded(thread.id) ? thread.status ?? { type: "idle" } : { type: "notLoaded" } }));
      return { data, nextCursor: offset + data.length < all.length ? `oc:${offset + data.length}` : null };
    }
    if (method === "thread/unsubscribe") {
      const id = params.threadId, status = this.attachments.detach(clientId, id);
      if (status === "unsubscribed" && this.attachments.count(id) === 0) {
        if (this.catalog.get(id)?.ephemeral === true) {
          try {
            if (!(await this.release(id)).released) throw new Error("Engine did not release the temporary thread");
            this.attachments.unload(id); this.catalog.forgetTemporary(id); this.closedTemporaryIds.add(id);
            this.notify("thread/closed", { threadId: id });
          } catch (error) { this.attachments.attach(clientId, id); throw error; }
        } else this.scheduleUnload(id);
      }
      return { status };
    }
    const savedModel = ["thread/resume", "thread/fork", "turn/start"].includes(method)
      ? this.catalog.configuration(params.threadId).model : undefined;
    const effectiveParams = params.model == null && typeof savedModel === "string" && savedModel !== "" && savedModel !== "dsh"
      ? { ...params, model: savedModel } : params;
    const restoring = method === "thread/resume" && typeof params.threadId === "string";
    if (restoring) {
      const threads = this.restoringClients.get(clientId) ?? new Set<string>();
      threads.add(params.threadId); this.restoringClients.set(clientId, threads);
    }
    try {
      const reply = await delegate(method, effectiveParams);
      this.assertClient(clientId);
      if (reply?.thread && ["thread/start", "thread/resume", "thread/fork"].includes(method)) {
        this.catalog.upsert(reply.thread, {
          ...(method === "thread/fork" ? { ephemeral: params.ephemeral === true, forkedFromId: params.threadId, parentThreadId: null } : {}),
          configuration: {
            ...Object.fromEntries(["model", "cwd", "runtimeWorkspaceRoots"].filter(key => reply[key] !== undefined).map(key => [key, reply[key]])),
            ...Object.fromEntries(["cwd", "agentId", "runtimeWorkspaceRoots", "developerInstructions", "permissions"]
              .filter(key => params[key] !== undefined && (key !== "developerInstructions" || params[key] !== null))
              .map(key => [key, params[key]])),
          },
        });
        this.attachments.attach(clientId, reply.thread.id); this.cancelTimer(reply.thread.id);
        if (method !== "thread/resume") this.notify("thread/started", { thread: this.catalog.get(reply.thread.id) });
      }
      return this.decorate(reply);
    } finally {
      if (restoring) {
        const threads = this.restoringClients.get(clientId);
        threads?.delete(params.threadId);
        if (threads?.size === 0) this.restoringClients.delete(clientId);
      }
    }
  }
  dispatch(method: string, params: Params, clientId: string, delegate: Delegate): Promise<any> {
    const id = typeof params.threadId === "string" ? params.threadId : "creating:" + clientId;
    return this.enqueue(id, () => this.execute(method, params, clientId, delegate));
  }
  /** Shared by lifecycle changes, capability replacement and execution admission. */
  enqueue<T>(id: string, execute: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(id) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(execute);
    this.operations.set(id, operation);
    void operation.then(() => { if (this.operations.get(id) === operation) this.operations.delete(id); }, () => { if (this.operations.get(id) === operation) this.operations.delete(id); });
    return operation;
  }
  private cancelTimer(id: string) { const timer = this.timers.get(id); if (timer) clearTimeout(timer); this.timers.delete(id); }
  touch(id: string): void { if (this.attachments.count(id) === 0 && this.attachments.isLoaded(id)) this.scheduleUnload(id); }
  private scheduleUnload(id: string): void {
    this.cancelTimer(id); if (this.closed || this.attachments.count(id)) return;
    const version = this.attachments.version(id);
    const timer = setTimeout(() => {
      this.timers.delete(id);
      const previous = this.operations.get(id) ?? Promise.resolve();
      const operation = previous.catch(() => undefined).then(async () => {
        if (this.closed || this.attachments.count(id) || this.attachments.version(id) !== version) return;
        try {
          const result = await this.release(id);
          if (!result.released) { this.scheduleUnload(id); return; }
          if (this.attachments.version(id) === version && this.attachments.unload(id)) {
            if (this.catalog.get(id)?.ephemeral) this.closedTemporaryIds.add(id);
            this.catalog.forgetTemporary(id); this.notify("thread/closed", { threadId: id });
          }
        } catch { this.scheduleUnload(id); }
      });
      this.operations.set(id, operation);
      void operation.finally(() => { if (this.operations.get(id) === operation) this.operations.delete(id); });
    }, this.graceMs);
    timer.unref(); this.timers.set(id, timer);
  }
  async disconnect(clientId: string): Promise<void> {
    this.disconnectedClients.add(clientId);
    if (this.closed) return;
    await Promise.all(this.attachments.disconnect(clientId).map(id => this.enqueue(id, async () => {
      if (this.closed || this.attachments.count(id)) return;
      if (this.catalog.get(id)?.ephemeral === true && this.attachments.count(id) === 0) {
        try {
          if ((await this.release(id)).released) { this.attachments.unload(id); this.catalog.forgetTemporary(id); this.closedTemporaryIds.add(id); this.notify("thread/closed", { threadId: id }); }
          else this.scheduleUnload(id);
        }
        catch { this.scheduleUnload(id); }
      } else this.touch(id);
    })));
  }
  revokeClient(clientId: string): void { this.disconnectedClients.add(clientId); }
  assertClient(clientId: string): void {
    if (this.disconnectedClients.has(clientId)) throw new Error("Thread client has disconnected");
  }
  async close(): Promise<void> {
    this.closed = true; for (const id of this.timers.keys()) this.cancelTimer(id);
    await Promise.allSettled(this.operations.values()); this.catalog.close();
  }
  expireTemporaryThreads(): void {
    for (const id of this.catalog.temporaryIds()) {
      this.cancelTimer(id); this.attachments.close(id); this.closedTemporaryIds.add(id); this.catalog.forgetTemporary(id);
      this.notify("thread/closed", { threadId: id });
    }
  }
  acceptedTurn(threadId: string, params: Params): void {
    const thread = this.catalog.get(threadId); if (!thread) return;
    this.catalog.upsert({ ...thread, extra: { ...thread.extra, dsh: { ...thread.extra?.dsh, blank: false } } },
      { configuration: typeof params.model === "string" ? { model: params.model } : {} });
  }
}
