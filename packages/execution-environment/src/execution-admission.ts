import { Worker } from "node:worker_threads";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { EnvironmentLaunchAdmission, EnvironmentLaunchContext } from "./environment-delivery.js";
import type { EnvironmentLaunchLocator } from "./environment-launch-receiver.js";
import type { GitExecutionLocator } from "./git-execution.js";

export interface ExecutionAdmissionReader {
  /** The durable admission of the exact Turn, or `null` for an unowned Turn.
   * Rejects when the store is unreadable or the admission is not current. */
  resolve(input: GitExecutionLocator): Promise<EnvironmentLaunchContext | null>;
  /** The v2 admission of the record `locator` names: a pending Codex input
   * (`null` without a Human owner) or a pending creation reservation. Rejects
   * when the record is missing, settled, expired or its Actor epoch changed. */
  admission(locator: EnvironmentLaunchLocator): Promise<EnvironmentLaunchAdmission | null>;
  close(): Promise<void>;
}
const unavailable = () => Error("environment_launch_unavailable");

/** Reads the execution owner's own durable admission in a Worker of the calling
 * process. No SQLite read runs on this event loop, and nothing falls back to it
 * after the Worker fails: every later read is refused. */
export function openExecutionAdmission(options: { workerFile: string; directory: string }): ExecutionAdmissionReader {
  if (![options.workerFile, options.directory].every((p) => typeof p === "string" && isAbsolute(p)))
    throw unavailable();
  const worker = new Worker(pathToFileURL(options.workerFile), {
    workerData: { directory: options.directory },
    // A TypeScript entry (source runs and tests) needs tsx; a bundle does not.
    ...(options.workerFile.endsWith(".ts") ? { execArgv: ["--import", "tsx"] } : {}),
  });
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  let sequence = 0,
    failed = false,
    closing: Promise<void> | undefined;
  const settle = () => (pending.size ? worker.ref() : worker.unref());
  const fail = () => {
    failed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(unavailable());
    }
    pending.clear();
  };
  worker.on("message", (reply: { id?: number; value?: unknown; error?: boolean }) => {
    const entry = typeof reply?.id === "number" ? pending.get(reply.id) : undefined;
    if (!entry) return;
    pending.delete(reply.id!);
    clearTimeout(entry.timer);
    settle();
    const value = reply.value;
    if (reply.error || (value !== null && (!value || typeof value !== "object" || Array.isArray(value))))
      entry.reject(unavailable());
    else entry.resolve(value);
  });
  worker.on("error", fail);
  worker.on("messageerror", fail);
  const exited = new Promise<void>((resolve) =>
    worker.once("exit", () => {
      fail();
      resolve();
    }),
  );
  settle();
  const request = <T>(message: { locator: unknown; kind?: "v2" }): Promise<T> => {
    if (failed || closing || pending.size >= 64) return Promise.reject(unavailable());
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        settle();
        reject(unavailable());
      }, 5000);
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      settle();
      worker.postMessage({ id, ...message });
    });
  };
  return {
    resolve: (input) => request<EnvironmentLaunchContext | null>({ locator: input }),
    admission: (locator) => request<EnvironmentLaunchAdmission | null>({ locator, kind: "v2" }),
    close() {
      return (closing ??= (async () => {
        fail();
        // The Worker closes its read handles, then exits; a stuck one is stopped.
        worker.postMessage({ type: "close" });
        const timer = setTimeout(() => void worker.terminate(), 2000);
        try {
          await exited;
        } finally {
          clearTimeout(timer);
        }
      })());
    },
  };
}
