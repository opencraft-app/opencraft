import { Worker } from "node:worker_threads";

type Value = Record<string, any>;
/** Read-only native storage adapter. Its Worker owns parsing and SQLite IO. */
export class ConnectedAgentHistory {
  private worker?: Worker;
  private readonly pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private sequence = 0;
  private closed = false;
  private failure?: Error;
  constructor(private readonly provider: "codex" | "cursor", private readonly home: string) {}
  private fail(error: Error): void {
    this.failure ??= error;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
  private request(nativeId: string, params: Value, kind: "turns" | "items" | "snapshot" | "usage"): Promise<any> {
    if (this.closed || this.failure) return Promise.reject(this.failure ?? new Error("Native history reader closed"));
    if (this.pending.size >= 32) return Promise.reject(new Error("Native history reader busy"));
    if (!this.worker) {
      this.worker = new Worker(new URL("./connected-agent-history-worker.mjs", import.meta.url), {
        execArgv: [], workerData: { provider: this.provider, home: this.home },
      });
      this.worker.on("error", error => this.fail(error));
      this.worker.on("exit", () => { if (!this.closed) this.fail(new Error("Native history reader exited")); });
      this.worker.on("message", packet => {
        const request = this.pending.get(packet.id); if (!request) return;
        this.pending.delete(packet.id);
        packet.error ? request.reject(new Error(packet.error)) : request.resolve(packet.result);
      });
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ id, nativeId, params, kind });
    });
  }
  read(nativeId: string, params: Value): Promise<{ data: any[]; nextCursor: string | null }> { return this.request(nativeId, params, "turns"); }
  items(nativeId: string, params: Value): Promise<any> { return this.request(nativeId, params, "items"); }
  snapshot(nativeId: string, params: Value): Promise<any[]> { return this.request(nativeId, params, "snapshot"); }
  usage(nativeId: string): Promise<Value | null> { return this.request(nativeId, {}, "usage"); }
  async close(): Promise<void> {
    this.closed = true; this.fail(new Error("Native history reader closed"));
    await this.worker?.terminate();
  }
}
