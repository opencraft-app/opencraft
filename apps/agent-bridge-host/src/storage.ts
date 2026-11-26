import { Worker } from 'node:worker_threads';
import { stat } from 'node:fs/promises';
import type { DatabaseOutcome } from '@opencraft/sqlite-node';

/** The owner refused an operation without a storage failure. */
export class StorageRefusal extends Error {}

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
  constructor(path: string, role: 'host' | 'inbox' | 'rollback-identities' = 'host', onFailure?: (error: Error) => void) {
    const source = import.meta.url.endsWith('/storage.ts');
    this.worker = new Worker(new URL(source ? './storage.worker.ts' : './storage.worker.mjs', import.meta.url), {
      workerData: { path, role },
      ...(source ? { execArgv: ['--import', 'tsx'] } : {}),
    });
    this.worker.on('message', ({ id, value, error, fatal, refused }) => {
      const operation = this.pending.get(id);
      if (!operation) return;
      this.pending.delete(id);
      if (error) {
        const reason = refused && !fatal ? new StorageRefusal(error) : Error(error);
        operation.reject(reason);
        if (fatal) fail(reason);
      } else operation.resolve(value);
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

export interface RollbackIdentityRow {
  readonly route: string;
  readonly native_id: string;
  readonly restorable: number;
}

/** Snapshot the former Engine Host's identities before serving Native requests. */
export async function readRollbackIdentityRows(path: string): Promise<readonly RollbackIdentityRow[]> {
  try {
    if (!(await stat(path)).isFile()) throw Error('Invalid Bridge storage path');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const storage = new Storage(path, 'rollback-identities');
  try {
    await storage.ready;
    return await storage.call<RollbackIdentityRow[]>('rollbackIdentities');
  } finally {
    await storage.close().catch(() => {});
  }
}
