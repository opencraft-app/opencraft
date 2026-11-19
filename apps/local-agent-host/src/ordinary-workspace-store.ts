import { Worker } from "node:worker_threads";
import type { DatabaseOutcome } from "@opencraft/sqlite-node";
import type { OrdinaryWorkspaceJournal, WorkspaceAuthority, WorkspaceLease } from "./ordinary-workspace-journal.js";
import type { ResolvedWorkspaceSelection } from "./ordinary-workspace-selection.js";
export type { WorkspaceAuthority, WorkspaceBinding, WorkspaceLease } from "./ordinary-workspace-journal.js";
/** One FIFO storage Worker owns all synchronous filesystem, SQL and migration
 * work. Acknowledgements follow commit; failure is terminal, never local fallback. */
export class OrdinaryWorkspaceStore {
  private readonly worker: Worker;
  readonly outcome: Promise<DatabaseOutcome>;
  private ready: Promise<DatabaseOutcome>;
  private sequence = 0;
  private accepted = 0;
  private closed = false;
  private failure?: Error;
  private closing?: Promise<void>;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  constructor(directory: string, deploymentId: string) {
    this.worker = new Worker(new URL("./ordinary-workspace-worker.mjs", import.meta.url), {
      workerData: { directory, deploymentId },
      execArgv: [],
    });
    let resolveReady!: (value: DatabaseOutcome) => void, rejectReady!: (error: Error) => void;
    this.outcome = this.ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Callers can await outcome; an unopened failed owner must not emit an
    // unhandled rejection before the first operation observes the same failure.
    void this.ready.catch(() => {});
    const fail = (error: Error) => {
      this.failure ??= error;
      rejectReady(this.failure);
      for (const request of this.pending.values()) request.reject(this.failure);
      this.pending.clear();
    };
    this.worker.on("message", (message) => {
      if (message.ready) {
        resolveReady(message.outcome);
        return;
      }
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.value);
    });
    this.worker.on("error", fail);
    this.worker.on("exit", (code) => {
      if (!this.closed || this.pending.size || code !== 0) fail(new Error("Workspace storage Worker exited"));
    });
  }
  private request<T>(method: string, args: unknown[]): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Workspace journal is closing"));
    if (this.failure) return Promise.reject(this.failure);
    if (this.accepted >= 256) return Promise.reject(new Error("Workspace journal capacity exceeded"));
    this.accepted++;
    return this.dispatch<T>(method, args).finally(() => {
      this.accepted--;
    });
  }
  private async dispatch<T>(method: string, args: unknown[]): Promise<T> {
    await this.ready;
    if (this.failure) throw this.failure;
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      try {
        this.worker.postMessage({ id, method, args });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  admit(
    scope: WorkspaceAuthority,
    intentId: string,
    selectionDigest: string,
  ): Promise<ReturnType<OrdinaryWorkspaceJournal["admit"]>> {
    return this.request("admit", [scope, intentId, selectionDigest]);
  }
  admitResolved(
    scope: WorkspaceAuthority,
    intentId: string,
    selection: ResolvedWorkspaceSelection,
  ): Promise<ReturnType<OrdinaryWorkspaceJournal["admitResolved"]>> {
    return this.request("admitResolved", [scope, intentId, selection]);
  }
  resolvedSelection(
    scope: WorkspaceAuthority,
    workspaceId: string,
  ): Promise<ReturnType<OrdinaryWorkspaceJournal["resolvedSelection"]>> {
    return this.request("resolvedSelection", [scope, workspaceId]);
  }
  attachThread(
    scope: WorkspaceAuthority,
    workspaceId: string,
    threadId: string,
  ): Promise<ReturnType<OrdinaryWorkspaceJournal["attachThread"]>> {
    return this.request("attachThread", [scope, workspaceId, threadId]);
  }
  beginThreadStart(
    scope: WorkspaceAuthority,
    lease: WorkspaceLease,
  ): Promise<ReturnType<OrdinaryWorkspaceJournal["beginThreadStart"]>> {
    return this.request("beginThreadStart", [scope, lease]);
  }
  confirmThreadStarted(
    scope: WorkspaceAuthority,
    lease: WorkspaceLease,
    threadId: string,
  ): Promise<ReturnType<OrdinaryWorkspaceJournal["confirmThreadStarted"]>> {
    return this.request("confirmThreadStarted", [scope, lease, threadId]);
  }
  pendingThreadStarts(
    hostId: string,
    afterWorkspaceId = "",
    limit = 100,
  ): Promise<ReturnType<OrdinaryWorkspaceJournal["pendingThreadStarts"]>> {
    return this.request("pendingThreadStarts", [hostId, afterWorkspaceId, limit]);
  }
  read(scope: WorkspaceAuthority, workspaceId: string): Promise<ReturnType<OrdinaryWorkspaceJournal["read"]>> {
    return this.request("read", [scope, workspaceId]);
  }
  forThread(scope: WorkspaceAuthority, threadId: string): Promise<ReturnType<OrdinaryWorkspaceJournal["forThread"]>> {
    return this.request("forThread", [scope, threadId]);
  }
  hasThread(hostId: string, threadId: string): Promise<ReturnType<OrdinaryWorkspaceJournal["hasThread"]>> {
    return this.request("hasThread", [hostId, threadId]);
  }
  beginCreate(
    scope: WorkspaceAuthority,
    workspaceId: string,
  ): Promise<ReturnType<OrdinaryWorkspaceJournal["beginCreate"]>> {
    return this.request("beginCreate", [scope, workspaceId]);
  }
  cancelUnsubmittedCreate(
    scope: WorkspaceAuthority,
    lease: WorkspaceLease,
  ): Promise<ReturnType<OrdinaryWorkspaceJournal["cancelUnsubmittedCreate"]>> {
    return this.request("cancelUnsubmittedCreate", [scope, lease]);
  }
  recordProviderReceipt(
    scope: WorkspaceAuthority,
    lease: WorkspaceLease,
    receipt: { instanceId: string; privateVolumeId: string },
  ): Promise<ReturnType<OrdinaryWorkspaceJournal["recordProviderReceipt"]>> {
    return this.request("recordProviderReceipt", [scope, lease, receipt]);
  }
  confirmCreated(
    scope: WorkspaceAuthority,
    lease: WorkspaceLease,
    instanceId: string,
  ): Promise<ReturnType<OrdinaryWorkspaceJournal["confirmCreated"]>> {
    return this.request("confirmCreated", [scope, lease, instanceId]);
  }
  beginRelease(
    scope: WorkspaceAuthority,
    lease: WorkspaceLease,
  ): Promise<ReturnType<OrdinaryWorkspaceJournal["beginRelease"]>> {
    return this.request("beginRelease", [scope, lease]);
  }
  markUncertain(
    scope: WorkspaceAuthority,
    lease: WorkspaceLease,
  ): Promise<ReturnType<OrdinaryWorkspaceJournal["markUncertain"]>> {
    return this.request("markUncertain", [scope, lease]);
  }
  confirmComputeAbsent(
    scope: WorkspaceAuthority,
    lease: WorkspaceLease,
  ): Promise<ReturnType<OrdinaryWorkspaceJournal["confirmComputeAbsent"]>> {
    return this.request("confirmComputeAbsent", [scope, lease]);
  }
  pendingForHost(
    hostId: string,
    afterWorkspaceId = "",
    limit = 100,
  ): Promise<ReturnType<OrdinaryWorkspaceJournal["pendingForHost"]>> {
    return this.request("pendingForHost", [hostId, afterWorkspaceId, limit]);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    // Already-accepted dispatches precede this close in the same ready queue.
    this.closing = (async () => {
      try {
        await this.dispatch("close", []);
      } finally {
        await this.worker.terminate();
      }
    })();
    return this.closing;
  }
}
