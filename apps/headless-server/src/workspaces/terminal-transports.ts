import { randomBytes } from "node:crypto";
import type { ProcessSnapshot } from "@opencraft/appserver-protocol";
import type { OrdinaryExecutionBinding } from "@opencraft/local-agent-host/ordinary-conversation-owner";
import { periodicOwnerWork, timeoutOwnerWake, type OwnerWake, type PeriodicOwnerWork } from "@opencraft/owner-wake";
import type { WorkspaceActorAdmission } from "./actor-authority.js";
import { receiptRetention, type ReceiptRetention } from "./receipt-retention.js";
export interface WorkspaceTerminalLease {
  workspaceId: string;
  generation: number;
}
export type WorkspaceTerminalStatus =
  { state: "pending" } | { state: "failed" } | { state: "complete"; result: unknown };
export interface WorkspaceTerminalPort {
  workspaceTerminalOpen(
    access: WorkspaceActorAdmission,
    threadId: string,
    lease: WorkspaceTerminalLease,
  ): Promise<string>;
  workspaceTerminalProbe(token: string): Promise<void>;
  workspaceTerminalRequest(
    token: string,
    access: WorkspaceActorAdmission,
    method: string,
    params: unknown,
  ): Promise<string>;
  workspaceTerminalStatus(operation: string): Promise<WorkspaceTerminalStatus>;
  workspaceTerminalForget(operation: string): Promise<void>;
  workspaceTerminalSnapshot(token: string, handle: string, afterSequence: number): Promise<ProcessSnapshot>;
  workspaceTerminalUnwatch(token: string): Promise<void>;
}
const shape = (token: unknown): token is string => typeof token === "string" && /^[a-f0-9]{64}$/u.test(token);
const invalid = () => Error("Workspace terminal unavailable");
const methods = new Set([
  "process/spawn",
  "process/attach",
  "process/list",
  "process/writeStdin",
  "process/resizePty",
  "process/kill",
]);
interface Watch {
  access: WorkspaceActorAdmission;
  threadId: string;
  lease: WorkspaceTerminalLease;
  binding: OrdinaryExecutionBinding;
}
interface Operation {
  status: WorkspaceTerminalStatus;
  work: Promise<void>;
  access: WorkspaceActorAdmission;
  settledAt?: number;
}
/** Worker owns only private correlation. Process lifetime/output replay remain
 * with the existing bound SandboxProcessService, not a new PTY or event log. */
export class WorkspaceTerminalTransfers {
  private readonly watches = new Map<string, Watch>();
  private readonly operations = new Map<string, Operation>();
  private closed = false;
  private readonly wake: OwnerWake;
  /** Settled operations are forgotten when they expire; nothing wakes while none has settled. */
  private readonly retention: ReceiptRetention;
  /** Authority and binding currency have no change notification, so open watches are re-checked every 500 ms; the
   * check is armed only while a watch is open. */
  private watchCheck: PeriodicOwnerWork | null = null;
  constructor(
    private readonly options: {
      current(access: WorkspaceActorAdmission, pending: boolean): boolean;
      binding(access: WorkspaceActorAdmission, threadId: string, resource: boolean): Promise<OrdinaryExecutionBinding>;
      /** Owner wake-up for watch checks and receipt expiry; the default Node timeout one. */
      wake?: OwnerWake;
    },
  ) {
    this.wake = options.wake ?? timeoutOwnerWake();
    this.retention = receiptRetention(this.operations, (operation) => operation.settledAt, this.wake);
  }
  private watched() {
    if (this.watches.size && !this.closed) {
      this.watchCheck ??= periodicOwnerWork(this.wake, 500, () => {
        for (const [token, watch] of this.watches)
          if (!this.options.current(watch.access, false) || watch.binding.isCurrent?.() !== true)
            this.watches.delete(token);
        this.watched();
      });
    } else {
      this.watchCheck?.close();
      this.watchCheck = null;
    }
  }
  private async get(token: string): Promise<Watch> {
    if (this.closed || !shape(token)) throw invalid();
    const watch = this.watches.get(token);
    if (!watch || !this.options.current(watch.access, false)) throw invalid();
    if (
      (await this.options.binding(watch.access, watch.threadId, true)) !== watch.binding ||
      watch.binding.isCurrent?.() !== true
    )
      throw invalid();
    const selection = await watch.binding.executionSelection?.();
    if (
      selection?.kind !== "bound" ||
      selection.workspaceId !== watch.lease.workspaceId ||
      selection.generation !== watch.lease.generation
    )
      throw invalid();
    return watch;
  }
  async open(access: WorkspaceActorAdmission, threadId: string, lease: WorkspaceTerminalLease): Promise<string> {
    if (
      this.closed ||
      this.watches.size >= 128 ||
      !this.options.current(access, true) ||
      typeof threadId !== "string" ||
      !threadId ||
      threadId.length > 512 ||
      !lease ||
      Object.keys(lease).some((k) => !["workspaceId", "generation"].includes(k)) ||
      typeof lease.workspaceId !== "string" ||
      !Number.isSafeInteger(lease.generation) ||
      lease.generation < 1
    )
      throw invalid();
    const binding = await this.options.binding(access, threadId, false);
    if (!binding.processes) throw invalid();
    const token = randomBytes(32).toString("hex");
    this.watches.set(token, { access, threadId, lease: { ...lease }, binding });
    this.watched();
    try {
      await this.get(token);
      if (!this.options.current(access, true)) throw invalid();
      return token;
    } catch (cause) {
      this.watches.delete(token);
      this.watched();
      throw cause;
    }
  }
  async probe(token: string) {
    const watch = await this.get(token);
    await watch.binding.processes!.probe();
    await this.get(token);
  }
  async begin(token: string, access: WorkspaceActorAdmission, method: string, params: unknown): Promise<string> {
    if (this.closed || this.operations.size >= 64 || !methods.has(method) || !this.options.current(access, true))
      throw invalid();
    const watch = await this.get(token);
    if (
      access.actorId !== watch.access.actorId ||
      access.generation !== watch.access.generation ||
      access.membershipRevision !== watch.access.membershipRevision
    )
      throw invalid();
    const operationToken = randomBytes(32).toString("hex"),
      value: Operation = { access, status: { state: "pending" }, work: undefined! };
    this.operations.set(operationToken, value);
    const snapshot = structuredClone(params);
    const current = () => {
      if (this.closed || !this.options.current(access, true) || watch.binding.isCurrent?.() !== true) throw invalid();
    };
    value.work = (async () => {
      try {
        current();
        const result = await watch.binding.processes!.dispatch(
          method,
          snapshot,
          { threadId: watch.threadId, projectId: null },
          current,
        );
        if ((await this.options.binding(access, watch.threadId, false)) !== watch.binding) throw invalid();
        current();
        value.status = { state: "complete", result };
      } catch {
        value.status = { state: "failed" };
      } finally {
        value.settledAt = this.retention.now();
        this.retention.settled();
      }
    })();
    return operationToken;
  }
  status(token: string): WorkspaceTerminalStatus {
    if (this.closed || !shape(token)) throw invalid();
    const value = this.operations.get(token);
    if (!value) throw invalid();
    return value.status;
  }
  forget(token: string) {
    if (!shape(token)) throw invalid();
    const value = this.operations.get(token);
    if (!value) return;
    if (value.status.state === "pending") throw invalid();
    this.operations.delete(token);
    this.retention.settled();
  }
  async snapshot(token: string, handle: string, afterSequence: number): Promise<ProcessSnapshot> {
    const watch = await this.get(token);
    if (
      typeof handle !== "string" ||
      !handle ||
      handle.length > 256 ||
      !Number.isSafeInteger(afterSequence) ||
      afterSequence < 0
    )
      throw invalid();
    const result = await watch.binding.processes!.request("process/attach", { processHandle: handle, afterSequence });
    await this.get(token);
    return result as ProcessSnapshot;
  }
  unwatch(token: string) {
    if (!shape(token)) throw invalid();
    this.watches.delete(token);
    this.watched();
  }
  async close() {
    this.closed = true;
    this.retention.close();
    this.watches.clear();
    this.watched();
    for (const value of this.operations.values()) Atomics.store(value.access.requestPermit, 0, 0);
    await Promise.all([...this.operations.values()].map((value) => value.work));
    this.operations.clear();
  }
}
