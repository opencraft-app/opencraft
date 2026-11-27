import { Worker, type ResourceLimits } from "node:worker_threads";
import { CLOSE_METHOD, type OwnerReply, type SerializedError } from "./protocol.js";

export { WorkerOwnerFatal } from "./serve.js";

/**
 * Resolves a Worker entry beside the calling module: `name.worker.ts` while the
 * caller runs from source, `name-worker.mjs` beside a bundled caller.
 */
export function ownerEntry(callerUrl: string, name: string): URL {
  return callerUrl.endsWith(".ts")
    ? new URL(`./${name}.worker.ts`, callerUrl)
    : new URL(`./${name}-worker.mjs`, callerUrl);
}

type ErrorConstructorLike = abstract new (...args: never[]) => Error;

export interface WorkerOwnerOptions {
  /** Names the owner in errors, e.g. "SSH connection storage". */
  readonly name: string;
  readonly workerData?: unknown;
  readonly resourceLimits?: ResourceLimits;
  /** Domain errors rebuilt with their class, matched by `error.name`, so callers keep `instanceof`. */
  readonly errors?: readonly ErrorConstructorLike[];
  /** Calls waiting at once before new calls are refused. */
  readonly maxPending?: number;
  /** Called once when the owner is lost (crash, exit or a fatal error). */
  readonly onFailure?: (error: Error) => void;
}

/** Turns each method of a synchronous owner into one that resolves after the Worker ran it. */
export type OwnerCalls<T> = {
  [K in keyof T as T[K] extends (...args: never[]) => unknown ? K : never]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

export class WorkerOwnerUnavailable extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkerOwnerUnavailable";
  }
}

/**
 * Main-thread side of a Worker that owns blocking IO (SQLite, sync files).
 * Ordinary calls run in FIFO order. An owner may explicitly admit synchronous
 * non-mutating reads while an async call waits; close drains both lanes. A
 * crashed or exited Worker fences the owner: pending and later calls reject,
 * and nothing falls back to running the IO on this thread.
 */
export class WorkerOwner<T> {
  private readonly worker: Worker;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private sequence = 0;
  private failure?: Error;
  private sealed = false;
  private closed = false;
  private closing?: Promise<void>;
  private ready!: { resolve(value: unknown): void; reject(error: Error): void };
  /** Typed calls, e.g. `owner.call.save(id, input)`. */
  readonly call: OwnerCalls<T>;

  private constructor(
    entry: URL,
    private readonly options: WorkerOwnerOptions,
  ) {
    const source = entry.pathname.endsWith(".ts");
    const tsxWorkerBootstrap = source
      ? `import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))}; register(); await import(${JSON.stringify(entry.href)});`
      : null;
    this.worker = tsxWorkerBootstrap
      ? new Worker(tsxWorkerBootstrap, {
          eval: true,
          execArgv: [],
          workerData: options.workerData,
          ...(options.resourceLimits ? { resourceLimits: options.resourceLimits } : {}),
        })
      : new Worker(entry, {
          workerData: options.workerData,
          ...(options.resourceLimits ? { resourceLimits: options.resourceLimits } : {}),
        });
    this.worker.on("message", (reply: OwnerReply) => this.receive(reply));
    this.worker.on("error", (error) =>
      this.fail(new WorkerOwnerUnavailable(`${options.name} failed`, { cause: error })),
    );
    this.worker.on("messageerror", (error) =>
      this.fail(new WorkerOwnerUnavailable(`${options.name} failed`, { cause: error })),
    );
    this.worker.on("exit", () => {
      if (!this.closed || this.pending.size) this.fail(new WorkerOwnerUnavailable(`${options.name} stopped`));
    });
    this.call = new Proxy({} as OwnerCalls<T>, {
      get: (_target, method) =>
        typeof method === "string" && method !== "then"
          ? (...args: unknown[]) => this.request(method, args)
          : undefined,
    });
  }

  /** Starts the Worker and resolves with its ready value once the owner opened. */
  static async open<T, R = unknown>(
    entry: URL,
    options: WorkerOwnerOptions,
  ): Promise<{ owner: WorkerOwner<T>; ready: R }> {
    let settle!: WorkerOwner<T>["ready"];
    const ready = new Promise<unknown>((resolve, reject) => {
      settle = { resolve, reject };
    });
    // Worker messages arrive on a later turn, after `ready` is assigned.
    const owner = new WorkerOwner<T>(entry, options);
    owner.ready = settle;
    try {
      const value = (await ready) as R;
      owner.settle();
      return { owner, ready: value };
    } catch (error) {
      owner.closed = true;
      await owner.worker.terminate();
      throw error;
    }
  }

  /** The error that fenced this owner, if any. */
  get unavailable(): Error | undefined {
    return this.failure;
  }

  /**
   * Runs every call made before it, closes the owner in the Worker, then stops
   * the Worker. Calls made after close() reject immediately.
   */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.failure) {
      this.closed = true;
      return (this.closing = this.worker.terminate().then(() => undefined));
    }
    const receipt = this.request(CLOSE_METHOD, []);
    this.sealed = true;
    return (this.closing = (async () => {
      try {
        await receipt;
      } finally {
        this.closed = true;
        await this.worker.terminate();
      }
    })());
  }

  /**
   * An idle owner does not keep the process alive, like the synchronous handle
   * it replaces; while a call (or opening) is in flight it does.
   */
  private settle(): void {
    if (this.pending.size) this.worker.ref();
    else this.worker.unref();
  }

  private request(method: string, args: readonly unknown[]): Promise<never> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.sealed || this.closed) return Promise.reject(new WorkerOwnerUnavailable(`${this.options.name} is closed`));
    if (this.pending.size >= (this.options.maxPending ?? 4096))
      return Promise.reject(new WorkerOwnerUnavailable(`${this.options.name} is busy`));
    const id = ++this.sequence;
    return new Promise<never>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.worker.ref();
      try {
        this.worker.postMessage({ id, method, args });
      } catch (error) {
        this.pending.delete(id);
        this.settle();
        reject(new WorkerOwnerUnavailable(`${this.options.name} could not receive the call`, { cause: error }));
      }
    });
  }

  private receive(reply: OwnerReply): void {
    if ("ready" in reply) {
      if (reply.ready) this.ready.resolve(reply.value);
      else this.ready.reject(this.rebuild(reply.error));
      return;
    }
    const call = this.pending.get(reply.id);
    if (!call) return;
    this.pending.delete(reply.id);
    this.settle();
    if (!("error" in reply)) {
      call.resolve(reply.value);
      return;
    }
    const error = this.rebuild(reply.error);
    call.reject(error);
    if (reply.fatal) {
      this.fail(new WorkerOwnerUnavailable(`${this.options.name} failed`, { cause: error }));
      void this.worker.terminate();
    }
  }

  private rebuild(serialized: SerializedError): Error {
    const type = this.options.errors?.find((candidate) => candidate.name === serialized.name);
    const error: Error = type ? Object.create(type.prototype) : new Error(serialized.message);
    Object.defineProperty(error, "message", { value: serialized.message, writable: true, configurable: true });
    if (type)
      Object.defineProperty(error, "stack", {
        value: `${serialized.name}: ${serialized.message}`,
        writable: true,
        configurable: true,
      });
    Object.assign(error, serialized.fields);
    if (!type && serialized.name !== "Error")
      Object.defineProperty(error, "name", { value: serialized.name, writable: true, configurable: true });
    return error;
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.ready?.reject(error);
    for (const call of this.pending.values()) call.reject(error);
    this.pending.clear();
    this.options.onFailure?.(error);
  }
}
