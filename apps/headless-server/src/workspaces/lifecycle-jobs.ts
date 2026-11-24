import { randomBytes } from "node:crypto";
import type { OwnerWake } from "@opencraft/owner-wake";
import { receiptRetention, type ReceiptRetention } from "./receipt-retention.js";
import type { OrdinaryThreadLifecycle } from "@opencraft/local-agent-host/ordinary-conversation-owner";
export type WorkspaceLifecycleRow = OrdinaryThreadLifecycle;
export type WorkspaceLifecycleStatus =
  { state: "pending" } | { state: "complete"; managed: boolean } | { state: "failed" };
export interface WorkspaceLifecyclePort {
  workspaceLifecycleBegin(row: WorkspaceLifecycleRow): Promise<string>;
  workspaceLifecycleStatus(token: string): Promise<WorkspaceLifecycleStatus>;
  workspaceLifecycleForget(token: string): Promise<void>;
}
/** Private correlation only. Physical cleanup runs outside the FIFO RPC lane;
 * the existing ordinary owner retains all actual teardown/unknown-state facts. */
export class WorkspaceLifecycleJobs {
  private readonly jobs = new Map<
    string,
    { state: WorkspaceLifecycleStatus; work: Promise<void>; finished?: number }
  >();
  private stopped = false;
  /** Finished receipts are forgotten when they expire; nothing wakes while none has finished. */
  private readonly retention: ReceiptRetention;
  constructor(
    private readonly apply: (row: WorkspaceLifecycleRow) => Promise<{ managed: boolean }>,
    wake?: OwnerWake,
  ) {
    this.retention = receiptRetention(this.jobs, (job) => job.finished, wake);
  }
  begin(row: WorkspaceLifecycleRow) {
    if (
      this.stopped ||
      this.jobs.size >= 64 ||
      !row ||
      Object.keys(row).some((k) => !["hostId", "threadId", "state", "generation"].includes(k)) ||
      row.hostId !== "local-codex" ||
      typeof row.threadId !== "string" ||
      !row.threadId ||
      row.threadId.length > 512 ||
      /[\x00-\x1f\x7f]/u.test(row.threadId) ||
      !Number.isSafeInteger(row.generation) ||
      row.generation < 1 ||
      !["active", "archived", "deleted"].includes(row.state)
    )
      throw Error("Workspace lifecycle unavailable");
    const snapshot = structuredClone(row),
      token = randomBytes(32).toString("hex"),
      job = {
        state: { state: "pending" } as WorkspaceLifecycleStatus,
        work: undefined! as Promise<void>,
        finished: undefined as number | undefined,
      };
    this.jobs.set(token, job);
    job.work = Promise.resolve()
      .then(() => this.apply(snapshot))
      .then(
        (value) => {
          job.state = { state: "complete", managed: value.managed };
        },
        () => {
          job.state = { state: "failed" };
        },
      )
      .finally(() => {
        job.finished = this.retention.now();
        this.retention.settled();
      });
    return token;
  }
  status(token: string) {
    if (this.stopped || !this.jobs.has(token)) throw Error("Workspace lifecycle receipt unavailable");
    return structuredClone(this.jobs.get(token)!.state);
  }
  forget(token: string) {
    const job = this.jobs.get(token);
    if (!job) return;
    if (job.state.state === "pending") throw Error("Workspace cleanup still pending");
    this.jobs.delete(token);
    this.retention.settled();
  }
  async close() {
    this.stopped = true;
    this.retention.close();
    await Promise.all([...this.jobs.values()].map((job) => job.work));
    this.jobs.clear();
  }
}
