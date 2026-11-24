import { isAbsolute } from "node:path";
import { WorkerOwner, ownerEntry } from "@opencraft/worker-owner";

/** Kernel locks for callers on an event loop that serves connections, where
 * opening a lock file synchronously is not allowed. One lazily started Worker
 * per process (`lock.worker.ts`, bundled as `lock-worker.mjs`) takes and holds
 * every lock; this thread only awaits it. The Worker does not keep the process
 * alive while idle. Its exit or the process's death releases every lock it holds. */
type Locks = {
  exclusive(path: string): number | null;
  owner(path: string): number | null;
  release(token: number): void;
};

let locks: Promise<WorkerOwner<Locks>> | undefined;
const lostListeners = new Set<() => void>();
function lockWorker(): Promise<WorkerOwner<Locks>> {
  const forget = () => {
    if (locks === opening) locks = undefined;
  };
  const opening = (locks ??= WorkerOwner.open<Locks>(ownerEntry(import.meta.url, "lock"), {
    name: "Lock files",
    onFailure: () => {
      forget();
      // The Worker's locks died with it.
      for (const lost of [...lostListeners]) lost();
    },
  }).then(
    ({ owner }) => owner,
    (error: unknown) => {
      forget();
      throw error;
    },
  ));
  return opening;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A short exclusive lock on `path` (a permanent private lock file) for one
 * critical section. Retries with backoff (20ms doubling to 200ms) while another
 * holder has it, then fails with `ELOCKED` ("Lock file is already being held"). */
export async function lockFileExclusive(path: string, { retries = 20 }: { retries?: number } = {}) {
  if (!isAbsolute(path)) throw new Error("Lock requires an absolute path");
  const worker = await lockWorker();
  for (let attempt = 0, wait = 20; ; attempt++, wait = Math.min(wait * 2, 200)) {
    const token = await worker.call.exclusive(path);
    if (token !== null) return () => worker.call.release(token);
    if (attempt >= retries)
      throw Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED", file: path });
    await delay(wait);
  }
}

/** `acquireOwnerLock` held off this thread: the same process-lifetime owner lock,
 * legacy conversion and `ELOCKED` refusal, retried one second apart. `onLost`
 * runs if the holding Worker fails while the lock is held (the lock is gone). */
export async function acquireOwnerLockOffThread(
  path: string,
  { retries = 0, onLost }: { retries?: number; onLost?: () => void } = {},
): Promise<() => Promise<void>> {
  if (!isAbsolute(path)) throw new Error("Writer lock requires an absolute path");
  const worker = await lockWorker();
  for (let attempt = 0; ; attempt++) {
    const token = await worker.call.owner(path);
    if (token !== null) {
      const lost = () => {
        lostListeners.delete(lost);
        onLost?.();
      };
      lostListeners.add(lost);
      let released: Promise<void> | undefined;
      return () => {
        lostListeners.delete(lost);
        return (released ??= worker.unavailable ? Promise.resolve() : worker.call.release(token));
      };
    }
    if (attempt >= retries)
      throw Object.assign(new Error("Writer lock is already being held or ownership cannot be verified"), {
        code: "ELOCKED",
        file: path,
      });
    await delay(1000);
  }
}
