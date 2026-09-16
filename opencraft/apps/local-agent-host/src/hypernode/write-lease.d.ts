export class ThreadWriteLeaseTable {
  constructor(options?: { editTtlMs?: number; disconnectTtlMs?: number });
  acquire(threadId: string, connection: object, phase?: string, now?: number): any;
  release(threadId: string, connection?: object | null): any;
  disconnect(connection: object, now?: number): any[];
  get(threadId: string, now?: number): any;
}
