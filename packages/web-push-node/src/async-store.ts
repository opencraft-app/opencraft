import { Worker } from "node:worker_threads";
import type { PushStore } from "./store";
import type { DatabaseOutcome } from "@opencraft/sqlite-node";
export type PushStorePort = {
  [K in keyof PushStore]: PushStore[K] extends (...args: infer A) => infer R
    ? (...args: A) => R | Promise<R>
    : PushStore[K];
};
/** One worker owns all SQLite IO, including migrations, retries and shutdown. */
export async function openPushStore(path: string): Promise<PushStorePort> {
  const source = import.meta.url.endsWith(".ts");
  const worker = new Worker(
    source ? new URL("./store.worker.ts", import.meta.url) : new URL("./push-storage-worker.mjs", import.meta.url),
    {
      workerData: { path },
      execArgv: source ? ["--import", "tsx"] : [],
    },
  );
  let sequence = 0,
    closed = false;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let readyResolve: (value: DatabaseOutcome) => void, readyReject: (error: Error) => void;
  const ready = new Promise<DatabaseOutcome>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const fail = () => {
    closed = true;
    const error = Error("notification_storage_unavailable");
    readyReject(error);
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  };
  worker.on("error", fail);
  worker.on("exit", () => {
    if (!closed || pending.size) fail();
  });
  worker.on("message", (message) => {
    if (message.ready) {
      readyResolve(message.outcome);
      return;
    }
    const p = pending.get(message.id);
    if (!p) return;
    pending.delete(message.id);
    message.error ? p.reject(Error(message.error)) : p.resolve(message.result);
  });
  const outcome = await ready;
  return new Proxy({ outcome } as PushStorePort, {
    get(_target, property) {
      if (property === "outcome") return outcome;
      if (property === "then") return undefined;
      return (...args: unknown[]) => {
        if (closed || pending.size >= 4096) return Promise.reject(Error("notification_storage_unavailable"));
        const id = ++sequence;
        const result = new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          try {
            worker.postMessage({ id, method: property, args: property === "keys" ? [] : args });
          } catch {
            pending.delete(id);
            reject(Error("notification_storage_unavailable"));
          }
        });
        if (property === "close")
          return result.finally(() => {
            closed = true;
            void worker.terminate();
          });
        return result;
      };
    },
  });
}
