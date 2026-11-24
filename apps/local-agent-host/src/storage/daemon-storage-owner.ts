import { mkdir, readFile, writeFile, unlink, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { observeNativeExecutionProcess } from "@opencraft/execution-environment/native-execution-origin";

/** Serialize owner claims, then use a live process identity for the whole storage lifetime.
 * The short mutex lease never spans synchronous SQLite migrations or engine startup.
 * The record carries the owner's process incarnation (birth and boot), so a PID reused by an
 * unrelated process (a restarted container's PID namespace repeats its PIDs) is not mistaken
 * for the previous owner. Cross-namespace exclusion belongs to the caller's kernel lock.
 */
export async function acquireLocalAgentStorageOwner(dataDirectory: string) {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const path = join(dataDirectory, ".daemon-storage-owner.json");
  const mutex = () => lockfile.lock(dataDirectory, {
    realpath: false, lockfilePath: join(dataDirectory, ".daemon-storage-owner.lock"),
    retries: { retries: 100, minTimeout: 100, maxTimeout: 100 },
  });
  const readOwner = async (): Promise<{ pid: number; claim: string; incarnation?: string } | null> => {
    try {
      const owner = JSON.parse(await readFile(path, "utf8"));
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.claim !== "string"
        || (owner.incarnation !== undefined && (typeof owner.incarnation !== "string" || !owner.incarnation))) throw new Error("Invalid daemon storage owner");
      return owner;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  };
  const claim = randomUUID();
  const releaseMutex = await mutex();
  try {
    const previous = await readOwner();
    if (previous) {
      let alive = true;
      try { process.kill(previous.pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; else throw error; }
      // A live PID with a different observed birth is another process; an unobservable one stays live.
      if (alive && previous.incarnation !== undefined) {
        const current = await observeNativeExecutionProcess(previous.pid).then(value => value.incarnation, () => undefined);
        if (current !== undefined && current !== previous.incarnation) alive = false;
      }
      if (alive) throw new Error(`Host storage already owned by live daemon ${previous.pid}`);
    }
    const temporary = `${path}.${claim}.tmp`;
    try {
      const incarnation = process.platform === "linux"
        ? await observeNativeExecutionProcess(process.pid).then(value => value.incarnation, () => undefined) : undefined;
      await writeFile(temporary, JSON.stringify({ pid: process.pid, claim, ...(incarnation ? { incarnation } : {}) }), { mode: 0o600 });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  } finally { await releaseMutex(); }
  let released = false;
  return async () => {
    if (released) return;
    const unlock = await mutex();
    try {
      if ((await readOwner())?.claim === claim) await unlink(path);
      released = true;
    } finally { await unlock(); }
  };
}
