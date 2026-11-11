/**
 * A single-consumer async input stream with admission receipts and withdrawal
 * before the consumer takes an item. Admission means the native transport read
 * the item; it is never evidence that a model saw it.
 */
export class InputWithdrawnError extends Error {
  constructor() {
    super("Input withdrawn before it reached the native transport");
    this.name = "InputWithdrawnError";
  }
}

interface Entry<T> {
  readonly value: T;
  readonly id: string;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  taken: boolean;
}

export class InputQueue<T> implements AsyncIterable<T> {
  private entries: Entry<T>[] = [];
  private waiter?: { resolve: (result: IteratorResult<T>) => void; reject: (error: Error) => void };
  private closed = false;
  private closeError?: Error;

  /** Resolves when the consumer takes the item; rejects if it is withdrawn or closed first. */
  push(value: T, id: string): Promise<void> {
    if (this.closed) return Promise.reject(this.closeError ?? new Error("Input stream closed"));
    return new Promise<void>((resolve, reject) => {
      const entry: Entry<T> = { value, id, resolve, reject, taken: false };
      const waiter = this.waiter;
      if (waiter !== undefined) {
        this.waiter = undefined;
        entry.taken = true;
        waiter.resolve({ value, done: false });
        resolve();
        return;
      }
      this.entries.push(entry);
    });
  }

  /** Remove one not-yet-taken item. Returns false once the consumer has it. */
  withdraw(id: string): boolean {
    const index = this.entries.findIndex((entry) => entry.id === id && !entry.taken);
    if (index < 0) return false;
    const [entry] = this.entries.splice(index, 1);
    entry!.reject(new InputWithdrawnError());
    return true;
  }

  pending(id: string): boolean {
    return this.entries.some((entry) => entry.id === id && !entry.taken);
  }

  get depth(): number {
    return this.entries.length;
  }

  close(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error;
    for (const entry of this.entries) entry.reject(error ?? new Error("Input stream closed"));
    this.entries = [];
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.resolve({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.entries.length > 0) {
          const entry = this.entries.shift()!;
          entry.taken = true;
          entry.resolve();
          return Promise.resolve({ value: entry.value, done: false });
        }
        if (this.closed) {
          return Promise.reject(this.closeError ?? new Error("Input stream closed"));
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiter = { resolve, reject };
        });
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}
