import { Worker } from 'node:worker_threads';
import type { DatabaseOutcome } from '@opencraft/sqlite-node';
/** Only async messages cross this boundary. A failed worker never falls back. */
export class Storage {
  private worker: Worker;
  private sequence = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private failure?: Error;
  private closed = false;
  private sealed = false;
  private closing?: Promise<void>;
  readonly ready: Promise<DatabaseOutcome>;
  constructor(path: string, role: 'host' | 'inbox' = 'host', onFailure?: (error: Error) => void) {
    this.worker = new Worker(new URL('./storage.worker.mjs', import.meta.url), { workerData: { path, role } });
    this.worker.on('message', ({ id, value, error, fatal }) => {
      const operation = this.pending.get(id);
      if (!operation) return;
      this.pending.delete(id);
      if (error) { operation.reject(Error(error)); if (fatal) fail(Error(error)); } else operation.resolve(value);
    });
    const fail = (error: Error) => {
      this.failure = error;
      for (const operation of this.pending.values()) operation.reject(error);
      this.pending.clear();
      onFailure?.(error);
    };
    this.worker.on('error', fail);
    this.worker.on('exit', () => { if (!this.closed) fail(Error('Bridge storage worker exited')); });
    this.ready = this.call('ready');
  }
  call<T = any>(op: string, args: unknown = {}): Promise<T> {
    if (this.failure || this.closed || this.sealed) return Promise.reject(this.failure ?? Error('Storage closing or closed'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.worker.postMessage({ id, op, args }); });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.closed) return Promise.resolve();
    // No await between the FIFO close marker and sealing new submissions.
    const receipt = this.call('close');
    this.sealed = true;
    return this.closing = (async () => {
      try { await receipt; } // all earlier requests committed, DB closed, writer released
      finally {
        this.closed = true;
        await this.worker.terminate();
        for (const operation of this.pending.values()) operation.reject(Error('Storage closed'));
        this.pending.clear();
      }
    })();
  }
}
