import { Worker } from "node:worker_threads";

export interface ExecutionFaultWrite {
  recoveryId: string;
  threadIds: readonly string[];
  recovered: boolean;
}

/** Fault receipts are committed outside the Host's connection event loop. */
export class ExecutionFaultWriter {
  private worker: Worker | null = null;
  private sequence = 0;
  private closing = false;
  private readonly pending = new Map<number, {resolve(value: readonly string[]): void; reject(error: Error): void}>();
  constructor(private readonly directory: string) {}
  write(operation: ExecutionFaultWrite): Promise<readonly string[]> {
    if (this.closing) return Promise.reject(new Error("Execution fault storage is closing"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      try {
        const worker = this.start();
        this.pending.set(id, {resolve, reject});
        worker.ref(); worker.postMessage({id, operation});
      } catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  private start(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./execution-fault-worker.mjs", import.meta.url), {
      workerData: {directory: this.directory}, execArgv: [],
    });
    this.worker = worker;
    worker.on("message", message => {
      const request = this.pending.get(message.id);
      if (!request || this.worker !== worker) return;
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error("Execution fault commit failed")); else request.resolve(message.changedThreadIds);
      if (!this.pending.size) worker.unref();
    });
    const fail = () => {
      if (this.worker !== worker) return;
      this.worker = null;
      for (const request of this.pending.values()) request.reject(new Error("Execution fault storage unavailable"));
      this.pending.clear(); void worker.terminate();
    };
    worker.on("error", fail); worker.on("exit", fail); worker.unref();
    return worker;
  }
  async close(): Promise<void> {
    this.closing = true;
    while (this.pending.size) await new Promise(resolve => setTimeout(resolve, 5));
    const worker = this.worker; this.worker = null;
    if (!worker) return;
    // A close message drains the owner's DB connections before acknowledging.
    await new Promise<void>((resolve, reject) => {
      worker.once("exit", code => code === 0 ? resolve() : reject(new Error("Execution fault storage close failed")));
      worker.ref(); worker.postMessage({close: true});
    });
  }
}
