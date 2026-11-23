import type { WorkspaceExecutionPort } from "./execution-owner.js";

/** Read-only committed projection for synchronous adapter classification. It is
 * refreshed before an attachment is exposed and after every physical receipt.
 * A failed/incomplete refresh fences classification; it never empties the set
 * and turns a remote Thread into a local one. Core separately checks Native's
 * own selection before accepting a local execution claim. */
export class WorkspacePlacementProjection {
  private threads = new Set<string>();
  private readonly observedRemote = new Set<string>();
  private readonly observedLocal = new Set<string>();
  private ready = false;
  private closed = false;
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  constructor(private readonly port: Pick<WorkspaceExecutionPort, "workspacePlacementPage">) {}
  conversationScopes() {
    if (this.closed || !this.ready) throw Error("Workspace placement unavailable");
    return [...new Set([...this.threads, ...this.observedRemote])].map((threadId) => ({
      hostId: "local-codex",
      threadId,
    }));
  }
  refresh(): Promise<void> {
    if (this.closed || this.pending >= 64) {
      this.invalidate();
      return Promise.reject(Error("Workspace placement unavailable"));
    }
    this.pending++;
    const work = this.tail
      .then(async () => {
        if (this.closed) throw Error("Workspace placement unavailable");
        const next = new Set<string>();
        let cursor: string | undefined;
        for (;;) {
          const page = await this.port.workspacePlacementPage(cursor);
          if (!page || !Array.isArray(page.items) || page.items.length > 256)
            throw Error("Invalid workspace placement page");
          let lastCursor = cursor;
          for (const row of page.items) {
            if (
              row.hostId !== "local-codex" ||
              typeof row.threadId !== "string" ||
              !row.threadId ||
              row.threadId.length > 512 ||
              /[\x00-\x1f\x7f]/u.test(row.threadId) ||
              typeof row.workspaceId !== "string" ||
              !row.workspaceId ||
              (lastCursor !== undefined && row.workspaceId + "." + Buffer.from(row.threadId, "utf8").toString("hex") <= lastCursor)
            )
              throw Error("Invalid workspace placement page");
            lastCursor = row.workspaceId + "." + Buffer.from(row.threadId, "utf8").toString("hex");
            next.add(row.threadId);
          }
          if (next.size > 100000) throw Error("Workspace placement capacity reached");
          if (page.next === null) break;
          if (
            typeof page.next !== "string" ||
            page.next !== lastCursor ||
            (cursor !== undefined && page.next <= cursor)
          )
            throw Error("Workspace placement cursor did not advance");
          cursor = page.next;
        }
        if (this.closed) throw Error("Workspace placement unavailable");
        this.threads = next;
        this.ready = true;
      })
      .catch((cause) => {
        this.ready = false;
        throw cause;
      })
      .finally(() => {
        this.pending--;
      });
    this.tail = work.catch(() => {});
    return work;
  }
  has(threadId: string): boolean {
    if (this.closed || !this.ready) throw Error("Workspace placement unavailable");
    return this.threads.has(threadId) || this.observedRemote.has(threadId);
  }
  /** Private Native metadata only, never a renderer response or cached cwd. */
  observeNativeThread(input: unknown) {
    if (this.closed || !input || typeof input !== "object") return;
    const thread = input as { id?: unknown; environments?: unknown };
    if (typeof thread.id !== "string" || !thread.id || thread.id.length > 512 || /[\x00-\x1f\x7f]/u.test(thread.id))
      return;
    const environments = thread.environments;
    this.observedLocal.delete(thread.id);
    if (!Array.isArray(environments)) return;
    if (
      environments.some(
        (value) =>
          value &&
          typeof value === "object" &&
          "environmentId" in value &&
          typeof value.environmentId === "string" &&
          value.environmentId.startsWith("workspace-"),
      )
    ) {
      if (this.observedRemote.size >= 100000 && !this.observedRemote.has(thread.id)) {
        this.ready = false;
        throw Error("Workspace observation capacity reached");
      }
      this.observedRemote.add(thread.id);
    } else if (
      environments.length === 1 &&
      environments[0]?.environmentId === "opencraft" &&
      !this.observedRemote.has(thread.id) &&
      !this.threads.has(thread.id)
    ) {
      if (this.observedLocal.size >= 100000) throw Error("Workspace observation capacity reached");
      this.observedLocal.add(thread.id);
    }
  }
  isKnownLocal(threadId: string): boolean {
    if (this.has(threadId)) return false;
    return this.observedLocal.has(threadId);
  }
  invalidate() {
    this.ready = false;
    this.observedLocal.clear();
  }
  forgetNativeLocal() {
    this.observedLocal.clear();
  }
  close() {
    this.closed = true;
    this.ready = false;
  }
}
