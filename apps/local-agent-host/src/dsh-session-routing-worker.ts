import { Worker } from "node:worker_threads";
import type { DatabaseOutcome } from "@opencraft/sqlite-node";
import { DshRoutingProjection, DshRoutingRejection, type DshRoutingSnapshot, type DshSessionRoutingPort } from "./dsh-routing-projection.js";

type Mutation = "stage" | "publish" | "reconcile";
interface Reply { id: number; result?: unknown; snapshot?: DshRoutingSnapshot; outcome?: DatabaseOutcome; error?: { message: string; kind?: string; recoverable?: boolean; code?: DshRoutingRejection["code"] }; }
/** One SQLite owner. Network reads use only its last acknowledged committed
 * snapshot; losing that owner fences both reads and writes until explicit reopen. */
export class DshSessionRoutingWorker extends DshRoutingProjection implements DshSessionRoutingPort {
  private readonly worker: Worker;
  private readonly requests = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private sequence = 0;
  private failure?: Error;
  private ready = false;
  private stopping = false;
  private closeAcknowledged = false;
  private closing?: Promise<void>;
  private storageOutcome?: DatabaseOutcome;
  private constructor(path: string) {
    super();
    this.worker = new Worker(new URL("./dsh-session-routing-worker.mjs", import.meta.url), { workerData: { path }, execArgv: [] });
    this.worker.on("error", error => this.fail(error));
    this.worker.on("exit", () => { if (!this.stopping || !this.closeAcknowledged || this.requests.size) this.fail(new Error("DSH routing storage worker exited")); });
    this.worker.on("message", (reply: Reply) => {
      const request = this.requests.get(reply.id);
      if (!request) return;
      this.requests.delete(reply.id);
      if (reply.error) {
        if (reply.error.recoverable && reply.error.code && reply.snapshot) {
          this.replaceSnapshot(reply.snapshot);
          request.reject(new DshRoutingRejection(reply.error.code, reply.error.message));
          return;
        }
        const error = Object.assign(new Error(reply.error.message), { kind: reply.error.kind });
        request.reject(error); this.fail(error); void this.worker.terminate();
        return;
      }
      if (reply.snapshot) this.replaceSnapshot(reply.snapshot);
      if (reply.outcome) this.storageOutcome = reply.outcome;
      request.resolve(reply.result);
    });
  }
  static async open(path: string): Promise<DshSessionRoutingWorker> {
    const owner = new DshSessionRoutingWorker(path);
    try { await owner.request("snapshot", []); owner.ready = true; return owner; }
    catch (error) { await owner.worker.terminate(); throw error; }
  }
  get outcome(): DatabaseOutcome {
    this.assertReadable();
    return this.storageOutcome!;
  }
  protected override assertReadable(): void {
    if (this.failure) throw this.failure;
    if (!this.ready || this.stopping) throw new Error("DSH routing storage is unavailable");
  }
  private fail(error: Error): void {
    this.failure ??= error;
    for (const pending of this.requests.values()) pending.reject(this.failure);
    this.requests.clear();
  }
  private request(method: Mutation | "snapshot" | "close", args: unknown[]): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.stopping && method !== "close") return Promise.reject(new Error("DSH routing storage is closing"));
    if (this.requests.size >= 128 && method !== "close") return Promise.reject(new Error("DSH routing storage queue is full"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve, reject });
      try { this.worker.postMessage({ id, method, args }); }
      catch (error) { this.fail(error as Error); }
    });
  }
  async stage(...args: Parameters<DshSessionRoutingPort["stage"]>): Promise<void> { await this.request("stage", args); }
  async publish(...args: Parameters<DshSessionRoutingPort["publish"]>): Promise<void> { await this.request("publish", args); }
  async reconcile(...args: Parameters<DshSessionRoutingPort["reconcile"]>): Promise<boolean> { return this.request("reconcile", args); }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopping = true;
    return this.closing = (async () => { try { await this.request("close", []); this.closeAcknowledged = true; } finally { await this.worker.terminate(); } })();
  }
}
