import { parentPort, workerData } from "node:worker_threads";
import { CLOSE_METHOD, serializeError, type OwnerReply, type OwnerRequest } from "./protocol.js";

/** Marks an error after which the owner cannot continue (lost handle, failed
 * recovery). The WorkerOwner rejects the call and fences every later one. */
export class WorkerOwnerFatal extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkerOwnerFatal";
  }
}

export interface ServedOwner {
  /** Methods callers may invoke. Anything else is rejected without running. */
  readonly methods: Record<string, (...args: never[]) => unknown>;
  /** Value returned to `WorkerOwner.open`, such as a database outcome. */
  readonly ready?: unknown;
  /** Releases handles and locks after the last request. */
  close?(): void | Promise<void>;
}

/**
 * Runs inside the Worker. `open` creates the owner from `workerData`; requests
 * then run one at a time in arrival order, so a synchronous store keeps the
 * same atomicity it had on the main thread.
 */
export function serveWorkerOwner<D>(open: (data: D) => ServedOwner | Promise<ServedOwner>): void {
  const port = parentPort;
  if (!port) throw new Error("serveWorkerOwner must run inside a Worker");
  const post = (reply: OwnerReply) => port.postMessage(reply);
  let owner: ServedOwner;
  let queue = Promise.resolve();
  const start = (async () => {
    try {
      owner = await open(workerData as D);
      post({ ready: true, value: owner.ready });
      return true;
    } catch (error) {
      post({ ready: false, error: serializeError(error) });
      port.close();
      return false;
    }
  })();
  port.on("message", (request: OwnerRequest) => {
    queue = queue.then(async () => {
      if (!(await start)) return;
      if (request.method === CLOSE_METHOD) {
        try {
          await owner.close?.();
          post({ id: request.id, value: undefined });
        } catch (error) {
          post({ id: request.id, error: serializeError(error), fatal: true });
        }
        port.close();
        return;
      }
      const method = Object.hasOwn(owner.methods, request.method) ? owner.methods[request.method] : undefined;
      if (!method) {
        post({
          id: request.id,
          error: serializeError(new Error(`Unknown owner method ${request.method}`)),
          fatal: false,
        });
        return;
      }
      try {
        const value = await (method as (...args: readonly unknown[]) => unknown)(...request.args);
        post({ id: request.id, value });
      } catch (error) {
        post({ id: request.id, error: serializeError(error), fatal: error instanceof WorkerOwnerFatal });
      }
    });
  });
}
